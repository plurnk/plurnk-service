// {§derivation-vectors-background} — the initialization pass attaches graph, FTS, and summaries
// and hands vectors to the workspace pump: the model's first packet does not wait for them, a
// semantic query does. The 2026-08-29 batch spent a median 5 minutes and up to 48 of an 88-minute
// budget joining embeddings that one run in sixty-six went on to query.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { Db } from "../../src/core/Db.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, subscribeNotifications, waitFor } from "./_rpc.ts";

const execFileP = promisify(execFile);
const seedRepo = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-vectors-background-"));
    const env = hermeticGitEnv();
    await execFileP("git", ["init", "-q"], { cwd: root, env });
    await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
    await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
    await writeFile(join(root, "pay.ts"), "export function processPayment(invoice: Invoice) { return charge(invoice.total); }\n");
    await writeFile(join(root, "auth.ts"), "export function authenticate(user: User) { return verifyPassword(user); }\n");
    await writeFile(join(root, "cart.ts"), "export function addToCart(cart: Cart, item: Item) { cart.items.push(item); }\n");
    await execFileP("git", ["add", "."], { cwd: root, env });
    await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });
    return root;
};

// An OpenAI-compatible embedding endpoint that holds document embeddings until released and
// answers query embeddings at once. Vectors are bags of words, so "invoice" ranks pay.ts first.
const DIMENSIONS = 384;
const vectorFor = (text: string): number[] => {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    vector[0] = 0.01;
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        vector[createHash("sha1").update(word).digest().readUInt16BE(0) % DIMENSIONS] += 1;
    }
    return vector;
};
type Stub = { server: Server; baseUrl: string; documents: number; queries: number; hold: () => void; release: () => void; close: () => Promise<void> };
const startStub = async (): Promise<Stub> => {
    const waiting: Array<() => void> = [];
    let held = true;
    const stub = { documents: 0, queries: 0 } as Stub;
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; input: string | string[] };
            const inputs = Array.isArray(body.input) ? body.input : [body.input];
            const reply = (): void => {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({
                    object: "list",
                    model: body.model,
                    data: inputs.map((text, index) => ({ object: "embedding", index, embedding: vectorFor(text) })),
                    usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
                }));
            };
            const isDocument = inputs.some((text) => text.includes("export function"));
            if (isDocument) stub.documents += 1; else stub.queries += 1;
            if (isDocument && held) {
                waiting.push(reply);
                return;
            }
            reply();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the stub embedder did not bind a port");
    stub.server = server;
    stub.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    stub.hold = () => {
        held = true;
        stub.documents = 0;
        stub.queries = 0;
    };
    stub.release = () => {
        held = false;
        for (const reply of waiting.splice(0)) reply();
    };
    stub.close = () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    return stub;
};
// The embeddings route resolves once per process, so every case shares one endpoint.
const stub = await startStub();
after(async () => {
    stub.release();
    await stub.close();
});
const withEnv = async <T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
    const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    const apply = (entries: Record<string, string | undefined>): void => {
        for (const [key, value] of Object.entries(entries)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
    apply(values);
    try { return await fn(); } finally { apply(prior); }
};
const stubEnv = (stub: Stub, vectors: string | undefined): Record<string, string | undefined> => ({
    PLURNK_EMBEDDING_MODEL: "stub-embed/sentence-transformers/all-MiniLM-L6-v2",
    PLURNK_PROVIDERS_PROVIDER_STUB_EMBED_NPM: "@ai-sdk/openai-compatible",
    PLURNK_PROVIDERS_PROVIDER_STUB_EMBED_BASE_URL: stub.baseUrl,
    PLURNK_SERVICE_EMBED_DISABLE: "0",
    PLURNK_SERVICE_DERIVE_VECTORS: vectors,
});
// Members are stored workspace-relative, the shape git ls-files reports.
const disposition = async (db: Db, pathname: string): Promise<{ disposition: string; reason: string | null }> => {
    const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "file", pathname });
    assert.ok(entry !== undefined, `entry ${pathname} exists`);
    const row = await db.test_derivation_disposition.get<{ disposition: string; reason: string | null }>({ entry_id: entry.id });
    assert.ok(row !== undefined, `entry ${pathname} attached a derivation`);
    return { disposition: row.disposition, reason: row.reason };
};
type Progress = { notice: { kind?: string; phase?: string; stage?: string } };
const vectorPhases = (events: () => unknown[]): string[] => (events() as Progress[])
    .filter((e) => e?.notice?.kind === "embed_progress" && e.notice.stage === "vectors")
    .map((e) => String(e.notice.phase));

test("{§derivation-vectors-background} the first loop concludes with vectors pending; a semantic FIND holds until they land, then ranks", async () => {
    const root = await seedRepo();
    stub.hold();
    try {
        await withEnv(stubEnv(stub, undefined), async () => {
            const mock = new Mock({ contextWindow: 32768, responses: [
                makeMockResponse("## SEND0 [200]\nready", 50),
                makeMockResponse("## FIND0 (*.ts) <1,3>\n~charging an invoice\n\n## SEND0 [102]\nsearched", 50),
                makeMockResponse("## SEND0 [200]\ndone", 50),
                makeMockResponse("## FIND0 (log:///**/prompt) <1,3>\n~find the charge\n\n## SEND0 [102]\nlog searched", 50),
                makeMockResponse("## SEND0 [200]\nlog done", 50),
            ] });
            await withDaemon(mock, async (db, _daemon, addr) => {
                const ws = await connect(addr);
                try {
                    const events = subscribeNotifications(ws, "notice/event");
                    await rpcCall(ws, 1, "workspace.create", { name: "vectors-background", projectRoot: root });
                    const first = await runLoopToTerminal(ws, 2, { prompt: "say ready", policy: { proposals: "accept" } }, { timeoutMs: 60_000 });
                    assert.equal(first.result.status, 200);
                    assert.deepEqual(await disposition(db, "pay.ts"), { disposition: "lexical", reason: "vectors_pending" }, "the artifact attached before its vectors landed");
                    await waitFor(() => [stub.documents], ([n]) => n! >= 1, { timeoutMs: 10_000 }); // the pump is embedding behind the packet
                    let settled = false;
                    const second = runLoopToTerminal(ws, 3, { prompt: "find the charge", policy: { proposals: "accept" } }, { timeoutMs: 60_000 })
                        .finally(() => { settled = true; });
                    await sleep(300);
                    assert.equal(settled, false, "the semantic FIND holds while its candidates' vectors are pending");
                    stub.release();
                    const secondResult = await second;
                    assert.equal(secondResult.result.status, 200);
                    const find = (await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: secondResult.modelWorkerId! }))
                        .find(({ op }) => op === "FIND");
                    assert.ok(find !== undefined && find.status_rx === 200, `the semantic FIND resolved once the vectors landed; got ${find?.status_rx} ${find?.rx?.slice(0, 200)}`);
                    for (const file of ["pay.ts", "auth.ts", "cart.ts"]) assert.match(find.rx, new RegExp(file.replace(".", "\\.")), `the page carries ${file}`);
                    assert.ok(find.rx.indexOf("pay.ts") < find.rx.indexOf("auth.ts") && find.rx.indexOf("pay.ts") < find.rx.indexOf("cart.ts"), `the invoice file ranks first: ${find.rx.slice(0, 300)}`);
                    assert.equal((await disposition(db, "pay.ts")).disposition, "vector", "the pump upgraded the artifact");
                    assert.ok(vectorPhases(events).includes("complete"), `the pump's progress reached the client: ${JSON.stringify(vectorPhases(events))}`);
                    // Log rows written by the previous loops derive through the same pump; the log's
                    // semantic FIND settles them the same way.
                    const third = await runLoopToTerminal(ws, 4, { prompt: "search the log", policy: { proposals: "accept" } }, { timeoutMs: 60_000 });
                    assert.equal(third.result.status, 200);
                    const logFind = (await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: third.modelWorkerId! }))
                        .filter(({ op }) => op === "FIND").at(-1);
                    assert.ok(logFind !== undefined && logFind.status_rx === 200, `the log's semantic FIND resolved; got ${logFind?.status_rx} ${logFind?.rx?.slice(0, 200)}`);
                    assert.match(logFind.rx, /prompt/, "it ranked prompt rows");
                } finally { ws.close(); }
            });
        });
    } finally {
        stub.release();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§derivation-vectors-background} PLURNK_SERVICE_DERIVE_VECTORS=eager derives vectors inside the pass, before the first packet", async () => {
    const root = await seedRepo();
    stub.hold();
    try {
        await withEnv(stubEnv(stub, "eager"), async () => {
            const mock = new Mock({ contextWindow: 32768, responses: [makeMockResponse("## SEND0 [200]\nready", 50)] });
            await withDaemon(mock, async (db, _daemon, addr) => {
                const ws = await connect(addr);
                try {
                    await rpcCall(ws, 1, "workspace.create", { name: "vectors-eager", projectRoot: root });
                    let settled = false;
                    const first = runLoopToTerminal(ws, 2, { prompt: "say ready", policy: { proposals: "accept" } }, { timeoutMs: 60_000 })
                        .finally(() => { settled = true; });
                    await waitFor(() => [stub.documents], ([n]) => n! >= 1, { timeoutMs: 10_000 });
                    await sleep(300);
                    assert.equal(settled, false, "eager: the initialization turn waits for the vectors");
                    stub.release();
                    assert.equal((await first).result.status, 200);
                    assert.deepEqual(await disposition(db, "pay.ts"), { disposition: "vector", reason: null });
                } finally { ws.close(); }
            });
        });
    } finally {
        stub.release();
        await rm(root, { recursive: true, force: true });
    }
});
