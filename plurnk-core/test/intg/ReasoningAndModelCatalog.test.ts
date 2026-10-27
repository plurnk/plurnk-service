import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { Mock, type MockResponse, ModelProvider } from "@plurnk/plurnk-providers";
import { Validator } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertSession, insertLoop } from "./_db.ts";
import { waitForDb, withDaemon, HARNESS_WAIT_MS, waitFor } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { routeForSpec, specForRoute } from "../../src/server/model-route.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readSessionTopology } from "../SessionTopology.ts";
import { bindListener } from "./_http.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { SessionTranslator } from "@plurnk/plurnk-acp";
import { requestBody } from "../../../scripts/lib/test-fetch.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Digest } from "@plurnk/plurnk-digest";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { completeStmt } from "./_dsl.ts";

describe("ModelRoute", () => {
test("{§session-model-selection}: concurrent first selections share one immutable resolved route", async (t) => {
    const db = await openMigrated();
    try {
        const query = db.model_route_lookup;
        const get = query.get.bind(query);
        const bothRead = Promise.withResolvers<void>();
        let reads = 0;
        t.mock.method(query, "get", async (...args: Parameters<typeof get>) => {
            const row = await get(...args);
            if (++reads === 2) bothRead.resolve();
            await bothRead.promise;
            return row;
        });
        const spec = { provider: "openai", model: "first-selection" };
        const ids = await Promise.all([routeForSpec(db, spec), routeForSpec(db, spec)]);
        assert.ok(ids[0] !== null);
        assert.equal(ids[0], ids[1]);
        assert.deepEqual(await specForRoute(db, ids[0]), spec);
        assert.equal(await routeForSpec(db, spec), ids[0], "later lookup preserves the original identity");
        for (const distinct of [
            { ...spec, alias: "local" },
            { ...spec, baseUrl: "http://127.0.0.1:8080/v1" },
            { ...spec, model: "other-model" },
            { ...spec, provider: "other-provider" },
        ]) {
            const other = await routeForSpec(db, distinct);
            assert.notEqual(other, ids[0]);
            assert.deepEqual(await specForRoute(db, other), distinct);
            assert.deepEqual(await specForRoute(db, ids[0]), spec, "another selection never rewrites the original route");
        }
    } finally { await db.close(); }
});
});

describe("demo-reporting", () => {
test("{§methods-workspace-create} topology reporting counts children and grandchildren, not independent roots", async () => {
    const db = await openMigrated();
    try {
        const workspace = await insertWorkspace(db, "topology-report");
        const root = await insertSession(db, workspace, null, "root", "model");
        const independent = await insertSession(db, workspace, null, "independent", "model");
        const child = await insertSession(db, workspace, root, "child", "model");
        const grandchild = await insertSession(db, workspace, child, "grandchild", "model");
        const runtime = await RuntimeSession.ensure(db, workspace);
        const report = await readSessionTopology(db, workspace);
        assert.equal(report.delegatedSessions, 2);
        assert.deepEqual(new Set(report.sessions.map(({ id }) => id)), new Set([root, independent, child, grandchild, runtime]));
    } finally { await db.close(); }
});

test("{§packet-assembly} the advisory floor instrument measures a real initial packet", { timeout: 90_000 }, async () => {
    for (const items of ["0", "-1"]) {
        const { stdout } = await promisify(execFile)(process.execPath, [
            "--conditions=plurnk-dev", "--import=./test/setup.ts", "--env-file-if-exists=.env.defaults",
            "scripts/floor-report.mjs",
        ], {
            cwd: new URL("../../", import.meta.url), timeout: 40_000,
            env: { ...process.env, PLURNK_SERVICE_FILES_ITEMS: items },
        });
        assert.doesNotMatch(stdout, /floor report unavailable/);
        assert.match(stdout, /log rows\s+: [1-9]\d* rows, [1-9]\d* tok active, [1-9]\d* metadata/);
        if (items === "0") assert.doesNotMatch(stdout, /FIND \d+/, "disabled survey contributes no FIND weight");
        else assert.match(stdout, /FIND [1-9]\d*/, "enabled survey contributes its measured FIND weight");
        assert.match(stdout, /FLOOR \(approx\): ~[1-9]\d* tok/);
    }
});
});

describe("model-catalog-acp", () => {
test("{§session-model-selection}: ACP delivers route reasoning choices without creating a workspace or session", async (t) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, http });
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const url = `http://127.0.0.1:${http.httpAddress().port}/acp`;
    const initRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
        }),
    });
    assert.equal(initRes.status, 200);
    const connId = initRes.headers.get("acp-connection-id");
    assert.ok(connId);
    const sseAbort = new AbortController();
    t.after(() => sseAbort.abort());
    const sseRes = await fetch(url, {
        method: "GET",
        headers: { accept: "text/event-stream", "acp-connection-id": connId },
        signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
    const query = { provider: "google", search: "gemini-3.7-flash", availability: "all" as const };
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "acp-connection-id": connId },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "_plurnk/action",
            params: { kind: "models.list", params: query },
        }),
    });
    assert.equal(response.status, 202);
    let rpc: { id?: number; result?: unknown; error?: unknown } | undefined;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of sseRes.body!) {
        buf += decoder.decode(chunk, { stream: true });
        for (const frame of buf.split("\n\n")) {
            if (!frame.startsWith("data: ")) continue;
            const parsed = JSON.parse(frame.slice(6)) as { id?: number; result?: unknown; error?: unknown };
            if (parsed.id === 1) {
                rpc = parsed;
                break;
            }
        }
        if (rpc !== undefined) break;
    }
    sseAbort.abort();
    assert.ok(rpc !== undefined);
    assert.equal(rpc.error, undefined, JSON.stringify(rpc));
    const page = Validator.assertModelCatalogPage(rpc.result);
    assert.deepEqual(page, daemon.listModels(query));
    const model = page.items.find((item) => item.model === "gemini-3.7-flash");
    assert.ok(model);
    assert.deepEqual(model.capabilities.efforts, ["adaptive", "low", "medium", "high"]);
    assert.deepEqual(await daemon.listWorkspaces(), []);
});
});

describe("reasoning-carrier", () => {
const reasoned = (dsl: string, reasoning: string): MockResponse => {
    const response = makeMockResponse(dsl);
    return { ...response, assistant: { ...response.assistant, reasoning } };
};

test("{§methods-invocation}: a turn's admitted reasoning rides its first model operation row, announced and read, and no other row repeats it", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        reasoned([
            PlurnkParser.frame("READ (workspace:///facts.txt)", null),
            PlurnkParser.frame("NOTE", "Answer from the facts."),
        ].join("\n\n"), "First turn reasoning."),
        reasoned(PlurnkParser.frame("SEND [200]", "Done."), "Second turn reasoning."),
    ] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "reasoning-carrier", projectRoot: null });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "reasoner" });
        const announced = new Map<number, { op: unknown; reasoning?: unknown }>();
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method !== "log/entry") return;
            const { entry } = params as { entry: { id: number; session_id: number; origin: string; op: unknown; reasoning?: unknown } };
            if (entry.session_id === sessionId && entry.origin === "model" && entry.op !== null && !announced.has(entry.id)) announced.set(entry.id, entry);
        });
        try {
            const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "Report the facts." });
            await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }),
                (rows) => rows.some((row) => row.id === accepted.loopId && row.status === 200));
            const rows = (await daemon.readLog({ workspaceId, sessionId, loopId: accepted.loopId }))
                .filter((row) => row.origin === "model" && row.op !== null)
                .toSorted((left, right) => left.id - right.id);
            const carriers = [["READ", "First turn reasoning."], ["NOTE", null], ["SEND", "Second turn reasoning."]];
            assert.deepEqual(rows.map((row) => [row.op, row.reasoning ?? null]), carriers);
            assert.deepEqual(rows.map((row) => { const first = announced.get(row.id); return [first?.op, first?.reasoning ?? null]; }), carriers,
                "each row's first announcement already carries what a read returns");
        } finally {
            unsubscribe();
        }
    });
});
});

describe("reasoning-streaming", () => {
test("{§notifications}: provider SSE reaches standard ACP before the reasoning copy exists", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "streaming-reasoning");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Report the finding.");
        const translator = new SessionTranslator({ acpSessionId: "streaming", workspaceId, sessionId, origin: "http://acp.test" });
        const events: ReturnType<SessionTranslator["reasoning"]> = [];
        const ready = Promise.withResolvers<void>();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), reasoningEventNotify(_workspace, payload) {
            const translated = translator.reasoning(payload);
            events.push(...translated);
            if (translated.some(({ update }) => update.sessionUpdate === "agent_thought_chunk"
                && (update.content as { text?: string } | undefined)?.text === "Visible now.")) ready.resolve();
        } });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const send = (content: string, finish: string | null = null): void => controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ id: "streaming", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`,
        ));
        const provider = new ModelProvider({
            model: "m", url: "https://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
            temperature: 0.2, repeatPenalty: null, retryAttempts: 0, effort: { mode: "adaptive", budget: null }, reasoningResponseStyle: "think-tags",
            fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(stream) {
                controller = stream;
                send("<think>Visible now.");
            } }), { headers: { "Content-Type": "text/event-stream" } }),
        });
        const run = engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const timer = setTimeout(() => ready.reject(new Error("ACP reasoning was withheld until completion")), HARNESS_WAIT_MS);
        try {
            await ready.promise;
            assert.deepEqual(await db.test_model_reasoning_resources.all({ session_id: sessionId }), [], "the live signal cannot originate from a not-yet-created copy");
            assert.equal(events.filter(({ update }) => update.sessionUpdate === "agent_thought_chunk").length, 1);
        } finally {
            clearTimeout(timer);
            send("</think>````SEND [200]\nDone.\n````", "stop");
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
            assert.equal((await run).status, 200);
        }
        assert.deepEqual(
            events
                .filter(({ update }) => update.sessionUpdate === "agent_thought_chunk")
                .map(({ update }) => (update as { content?: { text?: string } }).content?.text),
            ["Visible now."],
        );
        const rows = await db.test_model_reasoning_resources.all<{ content: string }>({ session_id: sessionId });
        assert.equal(rows[0].content, "Visible now.");
    } finally {
        await db.close();
    }
});

for (const style of ["structured", "think-tags"] as const) test(`{§notifications}: interleaved ${style} responses retain their session, packet and accounting owners`, async () => {
    const db = await openMigrated();
    const cancellation = new AbortController();
    const pending: Array<Promise<unknown>> = [];
    try {
        const workspaceId = await insertWorkspace(db, `concurrent-reasoning-${style}`);
        const sessions: Array<{ name: string; sessionId: number; loopId: number }> = [];
        for (const name of ["alpha", "bravo", "charlie"]) {
            const sessionId = await insertSession(db, workspaceId, null, name);
            const loopId = await insertLoop(db, sessionId, 1, `Report ONLY_${name}.`);
            sessions.push({ name, sessionId, loopId });
        }
        const observed = new Map<number, string[]>();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), reasoningEventNotify(_workspace, event) {
            if (event.phase !== "content") return;
            const deltas = observed.get(event.sessionId) ?? [];
            deltas.push(event.delta);
            observed.set(event.sessionId, deltas);
        } });
        const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
        const requests = new Map<string, Record<string, unknown>>();
        const provider = new ModelProvider({
            model: "m", url: "https://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
            temperature: 0.2, repeatPenalty: null, retryAttempts: 0,
            effort: { mode: "adaptive", budget: null }, rawBody: true,
            reasoningResponseStyle: style === "think-tags" ? "think-tags" : "verbatim",
            supportsSlotPinning: true, slotCount: 2,
            fetch: async (_url, init) => {
                const body = JSON.parse(requestBody(init));
                const input = JSON.stringify(body.messages);
                const owners = sessions.filter(({ name }) => input.includes(`ONLY_${name}`));
                assert.equal(owners.length, 1, "each request carries exactly its own prompt");
                const { name } = owners[0];
                requests.set(name, body);
                return new Response(new ReadableStream<Uint8Array>({ start(stream) {
                    streams.set(name, stream);
                } }), { headers: { "Content-Type": "text/event-stream" } });
            },
        });
        const running = sessions.map(({ sessionId, loopId }) => engine.runTurn({
            provider, workspaceId, sessionId, loopId, messages: [], signal: cancellation.signal,
        }));
        pending.push(...running);
        const emit = (name: string, delta: object, finish: string | null = null, usage?: object): void => {
            streams.get(name)!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                id: "shared-server-id", object: "chat.completion.chunk", created: 1, model: "m",
                choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
            })}\n\n`));
        };
        await waitFor(() => [...streams.keys()], (names) => names.length === sessions.length);
        assert.equal(new Set([...requests.values()].map(({ id_slot }) => id_slot)).size, 2,
            "shared backend affinity does not become a response ownership key");
        for (const { name } of sessions.toReversed()) emit(name, style === "structured"
            ? { reasoning_content: `Thinking ${name}.` } : { content: `<think>Thinking ${name}.` });
        await waitFor(() => [...observed.keys()], (ids) => ids.length === sessions.length);
        for (const { name, sessionId } of sessions) assert.equal(observed.get(sessionId)!.join(""), `Thinking ${name}.`);
        for (const index of [1, 2, 0]) {
            const { name } = sessions[index];
            emit(name, { content: `${style === "think-tags" ? "</think>" : ""}\`\`\`\`SEND [200]
ONLY_${name}
\`\`\`\`` }, "stop", {
                prompt_tokens: 10 + index, completion_tokens: 20 + index, total_tokens: 30 + 2 * index,
            });
            streams.get(name)!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            streams.get(name)!.close();
        }
        const results = await Promise.all(running);
        for (const [index, { turnId, status }] of results.entries()) {
            const { name, sessionId } = sessions[index];
            assert.equal(status, 200);
            const calls = await db.test_model_calls.all<{ response: string }>({ turn_id: turnId });
            const response = JSON.parse(calls[0].response);
            assert.equal(response.assistant.reasoning, `Thinking ${name}.`);
            assert.equal(response.assistant.content, `\`\`\`\`SEND [200]\nONLY_${name}
\`\`\`\``);
            for (const other of sessions.filter((session) => session.sessionId !== sessionId)) {
                assert.ok(!JSON.stringify(response.rawBody).includes(other.name), "forensic raw chunks belong to this request only");
            }
            const resources = await db.test_model_reasoning_resources.all<{ content: string }>({ session_id: sessionId });
            assert.deepEqual(resources.map(({ content }) => content), [`Thinking ${name}.`]);
            const accounting = await db.test_provider_requests.all<{ usage_input: number; usage_output: number }>({ turn_id: turnId });
            assert.deepEqual(accounting.map(({ usage_input, usage_output }) => [usage_input, usage_output]), [[10 + index, 20 + index]]);
        }
    } finally {
        cancellation.abort();
        await Promise.allSettled(pending);
        await db.close();
    }
});
});

describe("usage-reasoning", () => {
for (const [label, reasoning, reasoningLine] of [
    ["readable", "thought hard", "thought hard"],
    ["hidden", null, "(provider reported 37 reasoning tokens; no readable reasoning content returned)"],
] as const) test(`{§provider-request-accounting} output ${label} reasoning usage is persisted and exposed by the digest`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-usage-reasoning-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, `ur-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const resp: MockResponse = {
            assistant: { content: "", reasoning, ops: [completeStmt("done")] },
            usage: {
                inputTokens: 100,
                outputTokens: 57,
                totalTokens: 157,
                inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0 },
                outputTokenDetails: { textTokens: 20, reasoningTokens: 37 },
            },
        };
        const provider = new Mock({ contextWindow: 100000, responses: [resp] });
        const r = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const requests = await db.test_provider_requests.all<{
            usage_output: number;
            usage_output_text: number;
            usage_output_reasoning: number;
        }>({ turn_id: r.turnId });
        assert.deepEqual(requests.map(({ usage_output, usage_output_text, usage_output_reasoning }) => ({
            usage_output,
            usage_output_text,
            usage_output_reasoning,
        })), [{
            usage_output: 57,
            usage_output_text: 20,
            usage_output_reasoning: 37,
        }]);
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        const reasoningMarkdown = await readFile(join(digestDir, "reasoning.md"), "utf8");
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            turns: Array<{ accounting: { usage: { outputTokenDetails: { reasoningTokens: number } } } }>;
        };
        assert.match(markdown, /input=100 output=57 reasoning=37 cache-read=0/);
        assert.match(reasoningMarkdown, new RegExp(reasoningLine.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.equal(json.turns.at(-1)?.accounting.usage.outputTokenDetails.reasoningTokens, 37,
            "the packet-bearing model turn retains reasoning usage after packetless initialization");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
});
