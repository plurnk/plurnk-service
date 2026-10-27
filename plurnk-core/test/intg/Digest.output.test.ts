import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { promisify } from "node:util";
import { Digest, DigestRender } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { Mock, AiSdkProvider, chatMessageText, assessRequestCapacity, type ProviderRequestAccounting, type ChatMessage, type ProviderAccounting } from "@plurnk/plurnk-providers";
import { openMigrated, insertLoop, insertSession, insertWorkspace, insertPacketTurn, insertTurn } from "./_db.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket, { type DurablePacket } from "../../src/core/StoredPacket.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { testArtifactPath, testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import type { Db } from "../../src/core/Db.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { testDeferredProviderCapacity } from "./_provider.ts";
import Engine from "../../src/core/Engine.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { editStmt, noteStmt, urlPath } from "./_dsl.ts";
import { requestBody } from "../../../scripts/lib/test-fetch.ts";
import { digestStems } from "./_packet.ts";
import ModelCall from "../../src/core/ModelCall.ts";
// eslint-disable-next-line no-restricted-imports -- inject a native query failure; all persistence still uses package-owned SqlRite statements.
import { StatementSync } from "node:sqlite";
import SqlRiteSync from "@possumtech/sqlrite/sync";

// ─── Digest.output.test.ts ───
{
const execFileP = promisify(execFile);

for (const kind of ["parent", "ancestor", "database", "input-alias", "output-alias", "linked-parent", "lexical-input-alias", "linked-input-parent"] as const) {
    test(`{§share-packet-names}: ${kind} output cannot remove its input`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-digest-overlap-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const directory = join(root, "evidence");
        await mkdir(directory);
        const original = join(directory, "plurnk.db");
        const db = await openMigrated(original);
        await db.close();
        await writeFile(join(directory, "witness.txt"), "preserve source evidence");
        const before = await readFile(original);
        let dbPath = original;
        let digestDir = directory;
        if (kind === "ancestor") digestDir = root;
        if (kind === "database") digestDir = original;
        if (kind === "input-alias") {
            dbPath = join(root, "input.db");
            await symlink(original, dbPath);
        }
        if (kind === "output-alias") {
            digestDir = join(root, "output");
            await symlink(directory, digestDir, "dir");
        }
        if (kind === "linked-parent") {
            const alias = join(root, "alias");
            await symlink(root, alias, "dir");
            digestDir = join(alias, "evidence");
        }
        if (kind === "lexical-input-alias" || kind === "linked-input-parent") {
            const external = join(root, "external.db");
            const externalDb = await openMigrated(external);
            await externalDb.close();
            dbPath = join(directory, "input.db");
            await symlink(external, dbPath);
            if (kind === "linked-input-parent") {
                const alias = join(root, "input-directory");
                await symlink(directory, alias, "dir");
                dbPath = join(alias, "input.db");
            }
        }
        let failure: unknown;
        try { Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir }); }
        catch (cause) { failure = cause; }
        assert.equal(existsSync(original), true, "digest must preserve the database pathname");
        assert.equal(existsSync(dbPath), true, "digest must preserve the caller's input pathname");
        assert.ok((await readFile(original)).equals(before), "digest must preserve its input database bytes");
        assert.equal(await readFile(join(directory, "witness.txt"), "utf8"), "preserve source evidence");
        assert.ok(failure instanceof Error);
        assert.equal(failure.message, `${resolve(digestDir)} already exists and is not an empty folder; remove it first`);
    });
}

test("{§share-packet-names}: a sibling with the database's filename prefix is valid; an occupied folder is refused, never cleared", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-sibling-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "evidence.db");
    const db = await openMigrated(dbPath);
    await db.close();
    const digestDir = join(root, "evidence");
    await mkdir(digestDir);
    await writeFile(join(digestDir, "stale.md"), "stale");
    assert.throws(() => Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir }), { message: `${digestDir} already exists and is not an empty folder; remove it first` });
    assert.equal(await readFile(join(digestDir, "stale.md"), "utf8"), "stale", "an occupied folder is never cleared");
    await rm(join(digestDir, "stale.md"));
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    assert.equal(existsSync(dbPath), true);
    assert.deepEqual(JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")).workspaces, []);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir: join(digestDir, "nested") });
    assert.equal(existsSync(join(digestDir, "nested", "digest.md")), true);
});

for (const entrypoint of ["CLI", "built package"]) {
    test(`{§share-packet-names}: the ${entrypoint} reports overlap without removing input evidence`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-digest-cli-overlap-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const dbPath = join(root, "plurnk.db");
        const db = await openMigrated(dbPath);
        await db.close();
        const args = entrypoint === "CLI"
            ? ["--conditions=plurnk-dev", "src/service.ts", "share", dbPath, root]
            : ["--input-type=module", "--eval", `
                import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
                Digest.run({ ...${JSON.stringify({ dbPath, digestDir: root })}, openEvidence: EvidenceReader.open });
            `];
        await assert.rejects(execFileP(process.execPath, args, {
            cwd: resolve(import.meta.dirname, "../.."),
        }), (cause: unknown) => {
            assert.ok(cause instanceof Error);
            const failure = cause as Error & { code: number; stderr: string };
            assert.equal(failure.code, 1);
            assert.ok(failure.stderr.includes(`${root} already exists and is not an empty folder; remove it first`));
            return true;
        });
        assert.equal(existsSync(dbPath), true);
    });
}

test("{§share-packet-names}: an empty output path is not the caller's working directory", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-empty-output-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    await writeFile(dbPath, "not opened during output validation");
    assert.throws(() => Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir: "" }), {
        message: "output directory must not be empty",
    });
    assert.equal(await readFile(dbPath, "utf8"), "not opened during output validation");
});

for (const name of ["requiem.json", "requiem.md"]) {
    test(`{§share-packet-names}: requiem cannot overwrite a database named ${name}`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-overlap-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const dbPath = join(root, name);
        const db = await openMigrated(dbPath);
        await db.close();
        const before = await readFile(dbPath);
        let failure: unknown;
        try { await Digest.requiem({ openEvidence: EvidenceReader.open, dbPath, digestDir: root, provider: new Mock({ contextWindow: 8192, responses: [] }) }); }
        catch (cause) { failure = cause; }
        assert.ok((await readFile(dbPath)).equals(before), "requiem must preserve its input database bytes");
        assert.ok(failure instanceof Error);
        assert.equal(failure.message, `${dbPath} already exists; remove it first`);
    });
}
}

// ─── Digest.boundary.test.ts ───
{
test("{§digest-evidence-reader}: the public reader supplies canonical packets to the independent report package", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const packet = StoredPacket.assert({
        weight: 1, attributions: [],
        sections: [{ name: "log", slot: "user", header: "Log", content: "observed evidence", weight: 1 }],
        assistant: { content: "", ops: [], reasoning: "independent report witness" },
        assistantRaw: { retained: "provider bytes" },
    });
    try {
        const workspaceId = await insertWorkspace(db, "reader-contract");
        const sessionId = await insertSession(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, sessionId, 1, "report the evidence");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await Turn.recordInference(db, turn.id, {
            packet: StoredPacket.stringify(packet), sections: StoredPacket.sections(packet),
            usageCurationBudget: null, finishReason: "stop", model: "fixture", meta: "{}",
        });
        await Turn.complete(db, turn.id, 200);
    } finally { await db.close(); }
    using evidence = EvidenceReader.open(dbPath);
    const [turn] = evidence.rows().turns;
    const view = evidence.packet(turn).packet;
    assert.ok(view);
    assert.deepEqual(view.messages(), PacketWire.packetToWireMessages(packet));
    assert.equal(view.slot("user"), PacketWire.renderSlot(packet.sections, "user"));
    assert.equal(view.assistant?.reasoning, "independent report witness");
    assert.deepEqual(view.assistantRaw, { retained: "provider bytes" });
    const digestDir = join(root, "digest");
    Digest.run({ dbPath, digestDir, openEvidence: EvidenceReader.open });
    assert.match(await readFile(join(digestDir, "reasoning.md"), "utf8"), /independent report witness/);
    assert.deepEqual(JSON.parse(await readFile(join(digestDir, "witness-1-1.wire.json"), "utf8")), view.messages());
});
}

// ─── Digest.cache-ledger.test.ts ───
{
// {§digest-forensic-fidelity}















const TMP_DIR = testArtifactPath("core");
const SYSTEM = "You are the analyst. Keep the system prompt byte-identical across turns.";
const LOG = ["1: READ docs/a.md", "2: READ docs/b.md", "3: EDIT docs/a.md"];

// Turn N's packet: the fixed system section plus a log that grows by one line per turn.
const packet = (turn: number): DurablePacket => ({
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: SYSTEM, weight: contentWeight(SYSTEM) },
        { name: "log", slot: "user", header: "Log", content: LOG.slice(0, turn).join("\n"), weight: 1 },
    ],
    attributions: [],
    assistant: { content: "emission", ops: [], reasoning: null },
    assistantRaw: null,
});

const prompt = (turn: number): string => PacketWire.packetToWireMessages(packet(turn))
    .map(({ role, content }) => `${role}\n${content}`)
    .join("\n");

const recordRequests = async (db: Db, turnId: number, usage: Array<{ input: number | null; cached: number | null }>, kind: "emission" | "bare" = "emission"): Promise<number[]> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({ turn_id: turnId, kind, attributions: "[]", model: "mock" });
    if (modelCall === undefined) throw new Error("cache-ledger fixture model call did not open");
    const attempt = kind === "emission"
        ? await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: modelCall.id })
        : undefined;
    if (kind === "emission" && attempt === undefined) throw new Error("cache-ledger fixture attempt did not open");
    const requestIds: number[] = [];
    for (const [index, { input, cached }] of usage.entries()) {
        const request = await db.engine_open_provider_request.get<{ id: number }>({
            inference_call_id: modelCall.id, sequence: index + 1, provider: "provider:mock", model: "mock",
        });
        if (request === undefined) throw new Error("cache-ledger fixture provider request did not open");
        const accounting: ProviderRequestAccounting = {
            provider: "provider:mock",
            model: "mock",
            outcome: "response",
            usage: {
                ...(input === null ? {} : { inputTokens: input, totalTokens: input + 5 }),
                outputTokens: 5,
                // A null cache read is a provider that reported no cache field at all, not a zero.
                ...(cached === null ? {} : { inputTokenDetails: { cacheReadTokens: cached } }),
                outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
            },
            cost: { kind: "estimated", amount: { amount: "0.01", currency: "USD" }, source: "fixture" },
        };
        await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
        requestIds.push(request.id);
    }
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        native_inputs: "[]",
        response: JSON.stringify({ assistant: { content: "emission", reasoning: null, finishReason: "stop", model: "mock" } }),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("cache-ledger:fixture")),
        finish_reason: "stop",
        model: "mock",
    });
    if (attempt !== undefined) await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
    return requestIds;
};

test("{§digest-forensic-fidelity}: consecutive requests of a loop carry their shared prefix beside the reported cache read", async () => {
    const dbPath = join(TMP_DIR, `cache-ledger-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    const requestIds: number[] = [];
    try {
        const workspaceId = await insertWorkspace(db, "cache-ledger");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const cacheReads: Array<number | null> = [0, 7, null];
        for (const [index, cacheRead] of cacheReads.entries()) {
            const turnId = await insertPacketTurn(db, loopId, index + 1, packet(index + 1), 200);
            requestIds.push(...await recordRequests(db, turnId, [{ input: 100, cached: cacheRead }]));
        }
    } finally { await db.close(); }

    const digestDir = join(TMP_DIR, `cache-ledger-out-${crypto.randomUUID()}`);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });

    // Turn N+1's prompt extends turn N's, so the shared prefix is turn N's whole prompt.
    assert.ok(prompt(2).startsWith(prompt(1)) && prompt(3).startsWith(prompt(2)), "the fixture prompts grow by extension");
    // The prefix's share of the packet estimate, applied to the reported input of 100 tokens.
    const cacheable = [0, Math.round((100 * contentWeight(prompt(1))) / contentWeight(prompt(2))), Math.round((100 * contentWeight(prompt(2))) / contentWeight(prompt(3)))];
    assert.ok(cacheable[1] > 0 && cacheable[1] < 100 && cacheable[2] > 0 && cacheable[2] < 100, "the fixture prefixes are proper shares of the reported input");

    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        provider_requests: Array<{ id: number; adjacentPrefixTokensEstimate: number | null; cachedTokens: number | null; inputTokens: number | null }>;
    };
    assert.deepEqual(
        json.provider_requests.map(({ id, adjacentPrefixTokensEstimate, cachedTokens, inputTokens }) => ({ id, adjacentPrefixTokensEstimate, cachedTokens, inputTokens })),
        [
            { id: requestIds[0], adjacentPrefixTokensEstimate: 0, cachedTokens: 0, inputTokens: 100 },
            { id: requestIds[1], adjacentPrefixTokensEstimate: cacheable[1], cachedTokens: 7, inputTokens: 100 },
            { id: requestIds[2], adjacentPrefixTokensEstimate: cacheable[2], cachedTokens: null, inputTokens: 100 },
        ],
    );

    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    const turnLines = markdown.split("\n").filter((line) => /^T\d+ \(model turn/u.test(line));
    assert.equal(turnLines.length, 3);
    assert.match(turnLines[0], / cost=\$0\.01 cache=0\/100(?: |$)/u, "the denominator is reported input, including the loop's first request");
    assert.match(turnLines[1], / cost=\$0\.01 cache=7\/100(?: |$)/u);
    assert.match(turnLines[2], / cost=\$0\.01 cache=\?\/100(?: |$)/u, "a provider that reported no cache field reads as ?");
    assert.match(
        markdown,
        /^## Workspace #\d+ — cache-ledger\n\nCache: 7 of 200 reported input tokens read from cache \(3.5%\) over 2 requests · 1 missing input or cache usage \(excluded\)$/mu,
        "the workspace line sums reported requests and names the unreported one apart",
    );
});

test("{§digest-forensic-fidelity}: measured cache ratios include first requests, cross-loop reuse, retries and missing packets", async () => {
    const dbPath = join(TMP_DIR, `cache-boundaries-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "cache-boundaries");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const first = await insertLoop(db, sessionId, 1, "first");
        const turn = await insertPacketTurn(db, first, 1, packet(1), 200);
        await recordRequests(db, turn, [{ input: 100, cached: 80 }, { input: 100, cached: 90 }]);
        const changed: DurablePacket = { ...packet(2), sections: [{ name: "system", slot: "system", header: null, content: "A different prompt", weight: 5 }] };
        await recordRequests(db, await insertPacketTurn(db, first, 2, changed, 200), [{ input: 100, cached: 95 }]);
        const second = await insertLoop(db, sessionId, 2, "second");
        await recordRequests(db, await insertPacketTurn(db, second, 1, packet(1), 200), [{ input: 100, cached: 99 }]);
        const missing = await db.test_open_inference_turn.get<{ id: number }>({ loop_id: second, sequence: 2 });
        assert.ok(missing);
        await recordRequests(db, missing.id, [{ input: 100, cached: 60 }]);
        for (const [index, usage] of [
            { input: 100, cached: null }, { input: null, cached: 20 }, { input: null, cached: null }, { input: 0, cached: 0 },
        ].entries()) {
            await recordRequests(db, await insertPacketTurn(db, second, index + 3, packet(1), 200), [usage]);
        }
    } finally { await db.close(); }
    const digestDir = join(TMP_DIR, `cache-boundaries-out-${crypto.randomUUID()}`);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        provider_requests: Array<{ adjacentPrefixTokensEstimate: number | null; cachedTokens: number | null; inputTokens: number | null }>;
    };
    const requests = json.provider_requests;
    assert.equal(requests.length, 9, "every physical request is accounted, including retries");
    assert.deepEqual(requests.map(({ cachedTokens, inputTokens }) => [cachedTokens, inputTokens]),
        [[80, 100], [90, 100], [95, 100], [99, 100], [60, 100], [null, 100], [20, null], [null, null], [0, 0]]);
    assert.equal(requests[0].adjacentPrefixTokensEstimate, 0);
    assert.equal(requests[1].adjacentPrefixTokensEstimate, 100);
    assert.ok(requests[2].adjacentPrefixTokensEstimate! < 95, "the local prefix estimate is not a cache-read limit");
    assert.equal(requests[3].adjacentPrefixTokensEstimate, 0, "a new loop resets only the adjacent-prefix diagnostic");
    assert.equal(requests[4].adjacentPrefixTokensEstimate, null, "missing packets affect only the optional prefix estimate");
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /Cache: 424 of 500 reported input tokens read from cache \(84.8%\) over 6 requests · 3 missing input or cache usage \(excluded\)/u);
    assert.match(markdown, /cache=170\/200/u, "same-turn physical requests sum both measured quantities");
    assert.match(markdown, /cache=99\/100/u);
    assert.match(markdown, /cache=20\/\?/u);
    assert.match(markdown, /cache=0\/0/u, "reported zero remains zero, not missing");
});

test("{§digest-forensic-fidelity}: BARE usage is measured without borrowing its parent's emission packet", async () => {
    const dbPath = join(TMP_DIR, `cache-bare-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "cache-bare");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertPacketTurn(db, loopId, 1, packet(1), 200);
        await recordRequests(db, turnId, [{ input: 100, cached: 80 }]);
        await recordRequests(db, turnId, [{ input: 20, cached: 5 }], "bare");
        await recordRequests(db, await insertPacketTurn(db, loopId, 2, packet(2), 200), [{ input: 100, cached: 90 }]);
    } finally { await db.close(); }
    const digestDir = join(TMP_DIR, `cache-bare-out-${crypto.randomUUID()}`);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        provider_requests: Array<{ kind: string; adjacentPrefixTokensEstimate: number | null; cachedTokens: number | null; inputTokens: number | null }>;
    };
    assert.deepEqual(json.provider_requests.map(({ kind, adjacentPrefixTokensEstimate, cachedTokens, inputTokens }) =>
        [kind, adjacentPrefixTokensEstimate, cachedTokens, inputTokens]), [
        ["emission", 0, 80, 100],
        ["bare", null, 5, 20],
        ["emission", null, 90, 100],
    ]);
    assert.match(await readFile(join(digestDir, "digest.md"), "utf8"),
        /Cache: 175 of 220 reported input tokens read from cache \(79.5%\) over 3 requests/u);
});

test("{§digest-forensic-fidelity}: zero and wholly unreported input have no invented percentage", async () => {
    const dbPath = join(TMP_DIR, `cache-unknown-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        for (const [name, usage] of [
            ["cache-zero", { input: 0, cached: 0 }],
            ["cache-unknown", { input: null, cached: null }],
        ] as const) {
            const workspaceId = await insertWorkspace(db, name);
            const sessionId = await insertSession(db, workspaceId, null, "analyst");
            const loopId = await insertLoop(db, sessionId, 1, "go");
            await recordRequests(db, await insertPacketTurn(db, loopId, 1, packet(1), 200), [usage]);
        }
    } finally { await db.close(); }
    const digestDir = join(TMP_DIR, `cache-unknown-out-${crypto.randomUUID()}`);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /cache-zero\n\nCache: 0 of 0 reported input tokens read from cache \(n\/a\) over 1 request\n/u);
    assert.match(markdown, /cache-unknown\n\nCache: 0 of 0 reported input tokens read from cache \(n\/a\) over 0 requests · 1 missing input or cache usage \(excluded\)/u);
});
}

// ─── Digest.cardinality.test.ts ───
{
test("{§digest-forensic-fidelity}: original failures, ambient observations and forked history retain their provenance", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-provenance-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    let parent = 0;
    let child = 0;
    let branch = 0;
    try {
        const workspaceId = await insertWorkspace(db, "digest-provenance");
        parent = await insertSession(db, workspaceId, null, "parent");
        child = await insertSession(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1, "inspect");
        const childLoop = await insertLoop(db, child, 1, "inspect");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const response = (ops: ReturnType<typeof noteStmt | typeof editStmt>[]) => ({ assistant: { content: "", reasoning: null, ops } });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            response([editStmt(urlPath("missing", "/parent"), "parent action")]),
            response([editStmt(urlPath("missing", "/child"), "child action")]),
            response([noteStmt("observed")]),
        ] });
        const messages = [{ role: "user" as const, content: "inspect" }];
        await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: child, loopId: childLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 2 });
        branch = await Fork.fork(db, parent, "branch");
    } finally { await db.close(); }

    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const { log_entries: entries } = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        log_entries: Array<{ session_id: number; origin: string; target: string; status_rx: number; inherited_history: boolean; ambient_event_id: number | null }>;
    };
    const failures = entries.filter(({ status_rx }) => status_rx >= 400);
    const original = failures.find(({ session_id, target }) => session_id === parent && target === "missing:///parent");
    const inherited = failures.find(({ session_id, target }) => session_id === branch && target === "missing:///parent");
    const childOriginal = failures.find(({ session_id, target }) => session_id === child && target === "missing:///child");
    const observation = failures.find(({ session_id, target }) => session_id === parent && target === "missing:///child");
    const inheritedObservation = failures.find(({ session_id, target }) => session_id === branch && target === "missing:///child");
    assert.ok(original && inherited && childOriginal && observation && inheritedObservation, "each original failure and its observed/copied forms survive export");
    assert.equal(original.origin, "model");
    assert.equal(original.inherited_history, false);
    assert.equal(original.ambient_event_id, null);
    assert.equal(inherited.origin, "model", "origin alone does not identify new model work");
    assert.equal(inherited.inherited_history, true);
    assert.equal(inherited.ambient_event_id, null);
    assert.equal(childOriginal.inherited_history, false);
    assert.equal(typeof childOriginal.ambient_event_id, "number", "a published action retains its occurrence identity too");
    assert.equal(observation.origin, "_plurnk");
    assert.equal(observation.inherited_history, false);
    assert.equal(typeof observation.ambient_event_id, "number");
    assert.equal(observation.ambient_event_id, childOriginal.ambient_event_id, "the observation names the actual originating event");
    assert.equal(inheritedObservation.inherited_history, true);
    assert.equal(inheritedObservation.ambient_event_id, observation.ambient_event_id, "copying an observation preserves the original occurrence identity");
});

test("{§digest-forensic-fidelity} digest Markdown exposes amplification as exact aggregates while JSON preserves every row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-cardinality-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    let sessionId = 0;
    let loopId = 0;
    let turnId = 0;
    let killId = 0;
    const readIds: number[] = [];
    try {
        const workspaceId = await insertWorkspace(db, "digest-cardinality");
        sessionId = await insertSession(db, workspaceId);
        loopId = await insertLoop(db, sessionId, 1, "amplify");
        turnId = await insertTurn(db, loopId, 1, 200);
        const insert = async (
            sequence: number,
            origin: "model" | "_plurnk",
            op: "READ" | "EDIT" | "atlas" | "KILL",
            pathname: string,
            attrs: object,
            hostname: string | null = null,
            scheme: string | null = "https",
            query: string | null = null,
            port: number | null = null,
            fragment: string | null = null,
        ): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence,
                origin, source: origin === "_plurnk" ? "session://researcher" : null, model_call_id: null,
                op,
                scheme, username: null, password: null, hostname, port,
                pathname, query, fragment, lineMarker: null,
                tx: "{}", mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200, content: "x" }), mimetype_rx: "application/json",
                status_rx: 200, weight: 1, state: "resolved", outcome: null,
                attrs: JSON.stringify(attrs),
            });
            if (row === undefined) throw new Error("digest log fixture insert returned no row");
            return row.id;
        };
        for (let i = 1; i <= 50; i++) readIds.push(await insert(i, "model", "READ", "/whale", {}, "example.test"));
        for (let i = 51; i <= 62; i++) await insert(i, "_plurnk", "EDIT", "/", { kind: "entry_materialized" }, `result${i}.test`);
        await insert(63, "model", "READ", "/wiki/Paris", {}, "en.wikipedia.org", "https", "b=2&a=1&a=3", 8443);
        await insert(64, "model", "atlas", "/filesystem_read_text_file", {
            stream: "atlas:///1/1/64/atlas",
        }, null, null);
        await insert(65, "_plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(66, "_plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(67, "_plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", null);
        await insert(68, "_plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", "");
        killId = await insert(69, "model", "KILL", "/**/READ", {
            __plurnk_curation: {
                targets: readIds.map((id) => ({
                    id,
                    activeBefore: 1,
                    activeAfter: 1,
                    foldedBefore: [],
                    foldedAfter: [[1, -1]],
                })),
                add: [],
                remove: [],
            },
        }, null, "log");
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            log_entries: Array<{
                session_id: number; loop_id: number; turn_id: number;
                origin: string; source: string | null; attrs: unknown;
                target: string | null; stream?: string;
            }>;
            log_curation_effects: Array<{
                operation_log_entry_id: number;
                target_log_entry_id: number;
                active_before: boolean;
                active_after: boolean;
                folded_before: Array<[number, number]>;
                folded_after: Array<[number, number]>;
            }>;
        };
        assert.match(markdown, /\[model\] READ\[200\] https:\/\/example\.test\/whale ×50 \(seq 1–50\)/);
        assert.match(markdown, /\[model\] READ\[200\] https:\/\/en\.wikipedia\.org:8443\/wiki\/Paris\?b=2&a=1&a=3/);
        assert.equal(
            markdown.match(/\[_plurnk\] materialized entry\[200\] https:\/\/result\d+\.test\//g)?.length,
            12,
            "distinct materialization targets remain distinct Markdown evidence",
        );
        assert.match(markdown, /\[_plurnk\] materialized entry\[200\] https:\/\/repeat\.test:9443\/page\?q=1#body source=session:\/\/researcher ×2 \(seq 65–66\)/);
        assert.match(markdown, /\[_plurnk\] materialized entry\[200\] https:\/\/empty\.test\/ source=session:\/\/researcher\n/, "an absent query has its own group");
        assert.match(markdown, /\[_plurnk\] materialized entry\[200\] https:\/\/empty\.test\/\? source=session:\/\/researcher\n/, "an explicit empty query has its own group");
        assert.match(markdown, /\[model\] atlas\[200\] filesystem_read_text_file stream=atlas:\/\/\/1\/1\/64/);
        assert.equal(json.log_entries.length, 69, "machine-readable evidence remains lossless");
        assert.equal(json.log_curation_effects.length, 50, "the suppressed broad scoped KILL retains every exact selected target");
        assert.deepEqual(json.log_curation_effects[0], {
            operation_log_entry_id: killId,
            target_log_entry_id: readIds[0],
            active_before: true,
            active_after: true,
            folded_before: [],
            folded_after: [[1, -1]],
        }, "the digest preserves the target the scoped KILL actually suppressed");
        assert.deepEqual(json.log_curation_effects[1]?.folded_before, [], "every selected target records its exact prior visibility");
        assert.deepEqual(
            json.log_entries[0],
            {
                id: 1, session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence: 1,
                origin: "model", source: null, model_call_id: null,
                inherited_history: false, ambient_event_id: null,
                attrs: {}, op: "READ", target: "https://example.test/whale",
                status_rx: 200, state: "resolved", outcome: null,
                initial_folded: [], projection: { active: true, folded: [[1, -1]] },
            },
            "JSON preserves the row's actor and lifecycle coordinates",
        );
        assert.equal(json.log_entries[50]?.origin, "_plurnk", "JSON distinguishes automatic materialization from model actions");
        assert.equal(json.log_entries[50]?.source, "session://researcher", "JSON preserves the causal session identity");
        assert.deepEqual(json.log_entries[50]?.attrs, { kind: "entry_materialized" }, "JSON preserves typed machine provenance");
        assert.equal(json.log_entries.find((entry) => entry.target?.includes("wikipedia"))?.target, "https://en.wikipedia.org:8443/wiki/Paris?b=2&a=1&a=3", "JSON preserves authority, port, and serialized query");
        assert.equal(json.log_entries.find((entry) => entry.stream !== undefined)?.stream, "atlas:///1/1/64/atlas", "JSON preserves an the execution's runtime stream identity");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
}

// ─── Digest.executor-evidence.test.ts ───
{
// {§digest-forensic-fidelity} — engine-materialized completion rows for a failed
// command are evidence, never errors: a loop that concluded green over red test
// runs is CLEAN, not DEGENERATE-WIN.








test("{§digest-forensic-fidelity}: executor completion rows never count toward health or errs", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-executor-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "digest-executor");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "fix");
        await db.test_set_loop_status.run({ id: loopId, status: 200, terminal_result: JSON.stringify({ status: 200, content: "done" }) });
        const turnId = await insertTurn(db, loopId, 1, 200);
        const insert = async (sequence: number, origin: "model" | "_plurnk", rx: object, status: number): Promise<void> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence,
                origin, source: origin === "_plurnk" ? "session://runner" : null, model_call_id: null,
                op: "READ",
                scheme: "sh", username: null, password: null, hostname: null, port: null,
                pathname: "/1/1/2", query: null, fragment: "stderr", lineMarker: null,
                tx: "{}", mimetype_tx: "application/json",
                rx: JSON.stringify(rx), mimetype_rx: "application/json",
                status_rx: status, weight: 1, state: "resolved", outcome: null,
                attrs: "{}",
            });
            if (row === undefined) throw new Error("fixture insert returned no row");
        };
        // The engine-materialized completion pair for an execution that failed to start.
        await insert(1, "_plurnk", { status: 500, problem: { type: "https://problems.plurnk.xyz/executor/sh/spawn-failed", title: "Command failed", status: 500, detail: "Could not start sh." } }, 500);
        await insert(2, "_plurnk", { status: 500, problem: { type: "https://problems.plurnk.xyz/executor/sh/spawn-failed", title: "Command failed", status: 500, detail: "Could not start sh." } }, 500);
        // A genuine model-fault row for contrast.
        await insert(3, "model", { status: 416, problem: { type: "https://problems.plurnk.xyz/scheme/file/range", title: "Range past end", status: 416, detail: "past the end" } }, 416);
    } finally { await db.close(); }

    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /errs=1\b/, "only the genuine fault counts in the errs badge");
    assert.doesNotMatch(markdown, /errs=[23]\b/, "executor evidence never inflates the badge");
    assert.match(markdown, /\(1 errors, 0 error-items\)|status=\d+ \(1 errors/, "health counts one error");
});

test("{§digest-forensic-fidelity}: a green conclusion over only red commands is CLEAN", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-executor-clean-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "digest-executor-clean");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "fix");
        await db.test_set_loop_status.run({ id: loopId, status: 200, terminal_result: JSON.stringify({ status: 200, content: "done" }) });
        const turnId = await insertTurn(db, loopId, 1, 200);
        const row = await db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "_plurnk", source: "session://runner", model_call_id: null,
            op: "READ",
            scheme: "sh", username: null, password: null, hostname: null, port: null,
            pathname: "/1/1/2", query: null, fragment: "stderr", lineMarker: null,
            tx: "{}", mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 500, problem: { type: "https://problems.plurnk.xyz/executor/sh/spawn-failed", title: "Command failed", status: 500, detail: "Could not start sh." } }),
            mimetype_rx: "application/json",
            status_rx: 500, weight: 1, state: "resolved", outcome: null,
            attrs: "{}",
        });
        if (row === undefined) throw new Error("fixture insert returned no row");
    } finally { await db.close(); }

    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /CLEAN/, "red commands under a green conclusion stay CLEAN");
    assert.doesNotMatch(markdown, /DEGENERATE-WIN/);
});
}

// ─── Digest.failed-request.test.ts ───
{
for (const capture of [false, true]) {
    test(`{§provider-request-accounting} recovery and digest retain failed output without executing or merging it; capture=${capture}`, async () => {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "failed-request-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const failedContent = "````EDIT (workspace:///never.txt)\nMust not execute.\n````";
        let calls = 0;
        const bodies: string[] = [];
        const provider = new AiSdkProvider({
            model: "evidence", url: "https://example.test/v1/chat/completions", streaming: true,
            rawBody: capture, contextWindow: 100_000, fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
            estimateCost: (usage) => usage === undefined ? { kind: "unknown", reason: "no usage" }
                : { kind: "estimated", amount: { amount: "0.25", currency: "USD" }, source: "fixture rates" },
            fetch: async (_input, init) => {
                calls++;
                bodies.push(requestBody(init));
                return new Response(`data: ${JSON.stringify({
                    id: `request-${calls}`, model: "evidence",
                    choices: [{ index: 0, delta: {
                        content: calls === 1 ? failedContent : "````SEND [200]\nRecovered.\n````",
                        reasoning_content: calls === 1 ? "Partial failed reasoning." : "Fresh reasoning.",
                    }, finish_reason: calls === 1 ? null : "stop" }],
                    ...(calls === 1 ? {} : { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }),
                })}\n\n`, { headers: { "content-type": "text/event-stream" } });
            },
        });
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "failed-evidence");
            const sessionId = await insertSession(db, workspaceId, null, "witness");
            const loopId = await insertLoop(db, sessionId, 1, "Recover.");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 3,
                messages: [{ role: "user", content: "Recover." }] });
            assert.equal(result.result.status, 200);
            assert.equal(calls, 2);
            assert.equal(await db.test_get_entry_by_pathname_scheme.get({ pathname: "/never.txt", scheme: "workspace" }), undefined);
        } finally { await db.close(); }
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.equal(digest.provider_requests.length, 2);
        const [failed, recovered] = await Promise.all(digest.provider_requests.map(async (request: { evidence: string }) =>
            JSON.parse(await readFile(join(digestDir, request.evidence), "utf8"))));
        assert.equal(failed.accounting.outcome, "error");
        assert.equal(failed.accounting.cost.kind, "unknown");
        assert.equal(failed.evidence.content, failedContent);
        assert.equal(failed.evidence.reasoning, "Partial failed reasoning.");
        assert.equal(failed.evidence.rawBody[0].id, "request-1");
        assert.match(failed.evidence.error.message, /without a finish reason/);
        assert.equal(recovered.accounting.outcome, "response");
        assert.equal(recovered.evidence.reasoning, "Fresh reasoning.");
        assert.equal(recovered.evidence.content, "````SEND [200]\nRecovered.\n````");
        assert.equal(digest.workspaces[0].accounting.costUsd, null);
        assert.equal(digest.workspaces[0].accounting.knownCostUsd, "0.25");
        assert.equal(digest.workspaces[0].accounting.usage, null);
        assert.equal(digest.workspaces[0].accounting.knownUsage.inputTokens, 100);
        const chronology = await readFile(join(digestDir, "reasoning.md"), "utf8");
        assert.match(chronology, /Physical request .*requests\/\d+\.md/);
        const failurePage = await readFile(join(digestDir, `requests/${failed.id}.md`), "utf8");
        assert.match(failurePage, /Partial output; this physical request failed/u);
        assert.match(failurePage, /Partial failed reasoning\./u);
        assert.ok(failurePage.includes(failedContent));
        assert.match(failurePage, /without a finish reason/u);
        if (capture) {
            assert.equal(failed.evidence.request.body, bodies[0]);
            assert.equal(recovered.evidence.request.body, bodies[1]);
            assert.ok(failurePage.includes(bodies[0]));
            assert.match(failurePage, /Exact serialized body/u);
        } else {
            assert.equal(failed.evidence.request, undefined);
            assert.match(failurePage, /Dispatched request body was not retained/u);
        }
        assert.match(failurePage, /\[Digest\]\(\.\.\/digest\.md\)/u);
        assert.match(failurePage, /unknown/u, "missing usage/cost is not reported as free");
        const recoveredPage = await readFile(join(digestDir, `requests/${recovered.id}.md`), "utf8");
        assert.match(recoveredPage, /Fresh reasoning\./u);
        assert.match(recoveredPage, /Recovered\./u);
        assert.doesNotMatch(recoveredPage, /Partial failed reasoning/u);
    });
}
}

// ─── Digest.memory.test.ts ───
{
const execFileP = promisify(execFile);

test("{§digest-forensic-fidelity}: exports repeated large wire evidence under a bounded heap without losing records", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-memory-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const digestDir = join(root, "digest");
    const db = await openMigrated(dbPath);
    const payload = "🌍".repeat(512 * 1024);
    const count = 16;
    try {
        const workspaceId = await insertWorkspace(db, "large-evidence");
        const sessionId = await insertSession(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, sessionId, 1, "retain every response");
        for (let index = 0; index < count; index++) {
            const content = `response-${index}`;
            const assistant = { content, ops: [], reasoning: `reasoning-${index}` };
            const assistantRaw = { content, evidence: payload };
            const packet = {
                weight: 1, attributions: [],
                sections: [{ name: "log", slot: "user", header: "Log", content: `request-${index}`, weight: 1 }],
                assistant, assistantRaw,
            } as const;
            const turnId = (await Turn.open(db, { loopId, producer: "model", kind: "inference" })).id;
            await Turn.recordInference(db, turnId, {
                packet: StoredPacket.stringify(StoredPacket.assert(packet)), sections: StoredPacket.sections(StoredPacket.assert(packet)),
                usageCurationBudget: null, finishReason: "stop", model: "fixture", meta: "{}",
            });
            const call = await db.engine_open_model_call.get<{ id: number }>({
                turn_id: turnId, kind: "emission", attributions: "[]", model: "fixture",
            });
            assert.ok(call);
            const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: call.id });
            assert.ok(attempt);
            await db.engine_observe_model_call_response.run({
                id: call.id, native_inputs: "[]", response: JSON.stringify({ assistant, assistantRaw }),
                failure: null, capacity: JSON.stringify(testDeferredProviderCapacity("digest:memory")),
                finish_reason: "stop", model: "fixture",
            });
            await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
            await Turn.recordSource(db, turnId, "ops", content, { modelCallId: call.id });
            await Turn.complete(db, turnId, 200);
        }
    } finally {
        await db.close();
    }
    await execFileP(process.execPath, [
        "--max-old-space-size=192", "--conditions=plurnk-dev", "src/service.ts", "share", dbPath, digestDir,
    ], { cwd: resolve(import.meta.dirname, "../.."), timeout: 20000, maxBuffer: 1024 * 1024 });
    const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    const stems = await digestStems(digestDir);
    assert.equal(digest.turns.length, count);
    assert.equal(digest.model_calls.length, count);
    assert.equal(digest.turn_attempts.length, count);
    for (let index = 0; index < count; index++) {
        const stem = stems[index];
        assert.equal(await readFile(join(digestDir, `${stem}.assistant.md`), "utf8"), `response-${index}`);
        assert.equal(JSON.parse(await readFile(join(digestDir, `${stem}.assistantRaw.json`), "utf8")).evidence, payload);
        assert.equal(digest.model_calls[index].response.assistantRaw.evidence, payload);
        assert.equal(digest.turn_attempts[index].response.assistantRaw.evidence, payload);
    }
    assert.match(await readFile(join(digestDir, "reasoning.md"), "utf8"), /reasoning-15/);
});
}

// ─── Digest.request-states.test.ts ───
{
test("{§share-packet-names}: pending, rejected and retired evidence remains distinguishable and navigable", async () => {
    const dir = await mkdtemp(join(await testArtifactDirectory("core"), "request-states-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const rejectedContent = "````EDIT (a.txt)\nunterminated";
    const reasoning = "## Heading in reasoning\n```text\nliteral\n```\n";
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "request-states");
        const sessionId = await insertSession(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, sessionId, 1, "inspect attempts");
        const turnId = await insertPacketTurn(db, loopId, 1, {
            weight: 0, sections: [{ name: "prompt", slot: "user", header: null, content: "Inspect.", weight: 0 }],
            attributions: [],
        });
        for (const state of ["rejected", "pending", "bare", "unadmitted"] as const) {
            const call = await ModelCall.open(db, { turnId, kind: state === "bare" ? "bare" : "emission", attributions: [], model: "fixture" });
            const attempt = state === "bare" ? undefined
                : await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: call.id });
            const settle = await call.observeRequest({ provider: "fixture", model: "fixture" });
            if (state === "pending" || state === "bare") continue;
            const accounting: ProviderRequestAccounting = {
                provider: "fixture", model: "fixture", outcome: "response",
                cost: { kind: "unknown", reason: "fixture has no billing evidence" },
            };
            await settle(accounting, { content: rejectedContent, reasoning });
            await call.observeResponse({
                assistant: { content: rejectedContent, reasoning, model: "fixture", finishReason: "stop" },
                assistantRaw: null, accounting: [accounting], capacity: testDeferredProviderCapacity(),
            });
            assert.ok(attempt);
            if (state === "rejected") await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 0, parse_errors: '[{"message":"Unclosed operation fence"}]' });
        }
    } finally { await db.close(); }
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const request = await readFile(join(digestDir, "witness-1-1.request.md"), "utf8");
    assert.match(request, /\| emission 1 \| rejected \| response \|/u);
    assert.match(request, /\| emission 2 \| not admitted \| pending \|/u);
    assert.match(request, /\| bare 3 \| not an emission \| pending \|/u);
    assert.match(request, /\| emission 4 \| not admitted \| response \|/u);
    assert.match(request, /### Emission attempt 4: unadmitted/u);
    assert.equal(await readFile(join(digestDir, "witness-1-1.attempt004.unadmitted.assistant.md"), "utf8"), rejectedContent);
    assert.match(request, /Unclosed operation fence/u);
    assert.match(request, /\[Exact output\]\(witness-1-1\.attempt001\.rejected\.assistant\.md\)/u);
    assert.equal(await readFile(join(digestDir, "witness-1-1.attempt001.rejected.assistant.md"), "utf8"), rejectedContent);
    const failurePage = await readFile(join(digestDir, "requests/1.md"), "utf8");
    assert.match(failurePage, /provider returned a response, but Plurnk rejected its emission/u);
    assert.match(failurePage, /Unclosed operation fence/u);
    assert.ok(failurePage.includes(rejectedContent));
    const pendingPage = await readFile(join(digestDir, "requests/2.md"), "utf8");
    assert.match(pendingPage, /Request is unsettled; accounting is not yet available/u);
    assert.match(pendingPage, /No settled response evidence is retained/u);
    assert.doesNotMatch(pendingPage, /admitted response|Partial output/u);
    const chronology = await readFile(join(digestDir, "reasoning.md"), "utf8");
    assert.ok(chronology.includes(reasoning));
    assert.ok(chronology.includes("````text\n" + reasoning + "\n````"), "reasoning cannot swallow the following attempt heading");
    for (const file of await readdir(digestDir, { recursive: true })) {
        if (!(file.endsWith(".request.md") || file.startsWith("requests/") && file.endsWith(".md") || file === "digest.md")) continue;
        const page = (await readFile(join(digestDir, file), "utf8")).replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gmu, "");
        for (const [, target] of page.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
            await access(join(digestDir, dirname(file), target));
        }
    }

    const retiring = await openMigrated(dbPath);
    try {
        await retiring.retention_retire_responses.run({ keep_turns: 0, keep_ms: -1, now_ms: Date.now() });
        await retiring.retention_retire_packets.run({ keep_turns: 0, keep_ms: -1, now_ms: Date.now() });
    } finally { await retiring.close(); }
    const retiredDir = join(dir, "retired-digest");
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir: retiredDir });
    assert.match(await readFile(join(retiredDir, "witness-1-1.request.md"), "utf8"), /Response evidence is not retained/u);
    const retiredRequest = await readFile(join(retiredDir, "witness-1-1.request.md"), "utf8");
    assert.match(retiredRequest, /No input message sections are retained/u);
    assert.doesNotMatch(retiredRequest, /## \d+\. (?:system|user)/u, "retired input is not an empty request");
    await assert.rejects(access(join(retiredDir, "witness-1-1.wire.json")), { code: "ENOENT" });
    await assert.rejects(access(join(retiredDir, "witness-1-1.user.md")), { code: "ENOENT" });
    assert.match(await readFile(join(retiredDir, "reasoning.md"), "utf8"), /response evidence is not retained; readable reasoning availability is unknown/u);
    await assert.rejects(access(join(retiredDir, "witness-1-1.attempt001.rejected.assistant.md")), { code: "ENOENT" }, "retired output cannot become a fabricated empty emission");
    const retiredPhysical = await readFile(join(retiredDir, "requests/1.md"), "utf8");
    assert.match(retiredPhysical, /Payload retention applied at .*; request identity and accounting remain/u);
    assert.ok(!retiredPhysical.includes(rejectedContent), "physical payloads expire with normalized responses");
    assert.match(retiredPhysical, /Unclosed operation fence/u, "admission evidence outlives payload retention");
    const before = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    const after = JSON.parse(await readFile(join(retiredDir, "digest.json"), "utf8"));
    assert.equal(after.provider_requests.length, 4);
    for (const [index, row] of after.provider_requests.entries()) {
        assert.equal(row.id, before.provider_requests[index].id);
        assert.deepEqual(row.accounting, before.provider_requests[index].accounting, "accounting stays exact, including unknown billing");
        await access(join(retiredDir, row.evidence));
        await access(join(retiredDir, `requests/${row.id}.md`));
        if (row.state === "pending") assert.equal(row.payloadsRetiredAt, undefined, "open requests have no invented expiry");
        else assert.match(row.payloadsRetiredAt, /^\d{4}-\d{2}-\d{2}T/);
    }
});
}

// ─── Digest.requiem-evidence-budget.test.ts ───
{
// {§digest-requiem} — quoted evidence is budgeted to the witness window;
// overflow elides the oldest attempts behind an explicit marker and the interview succeeds.













class WitnessMock extends Mock {
    calls: Array<{ messages: readonly ChatMessage[] }> = [];
    override async generate(args: Parameters<Mock["generate"]>[0]): ReturnType<Mock["generate"]> {
        this.calls.push({ messages: args.messages });
        return super.generate(args);
    }
}

const MODEL_PACKET: DurablePacket = {
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: "system for budget", weight: 1 },
        { name: "log", slot: "user", header: "Log", content: "log for budget", weight: 1 },
    ],
    attributions: [],
    assistant: { content: "final emission", ops: [], reasoning: null },
    assistantRaw: null,
};

const TMP_DIR = testArtifactPath("core");

const recordFatAttempt = async (db: Db, turnId: number, marker: string): Promise<void> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: turnId,
        kind: "emission",
        attributions: "[]",
        model: "mock",
    });
    if (modelCall === undefined) throw new Error("budget fixture model call did not open");
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: modelCall.id });
    if (attempt === undefined) throw new Error("budget fixture attempt did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:mock",
        model: "mock",
        outcome: "response",
        usage: {
            inputTokens: 2,
            outputTokens: 4,
            totalTokens: 6,
            inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 0 },
            outputTokenDetails: { textTokens: 2, reasoningTokens: 2 },
        },
        cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "budget fixture" },
    };
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("budget fixture provider request did not open");
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        native_inputs: "[]",
        response: JSON.stringify({
            assistant: { content: `${marker} ${"x".repeat(2600)}`, reasoning: null, finishReason: "stop", model: "mock" },
        }),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("requiem:budget")),
        finish_reason: "stop",
        model: "mock",
    });
    await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
};

test("{§digest-requiem}: overflowing evidence elides oldest attempts behind a marker and the interview lands", async () => {
    const savedMax = process.env.PLURNK_DIGEST_REQUIEM_MAX_TOKENS;
    const savedRetry = process.env.PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS;
    process.env.PLURNK_DIGEST_REQUIEM_MAX_TOKENS = "256";
    process.env.PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS = "512";
    try {
        const dbPath = join(TMP_DIR, `requiem-budget-${crypto.randomUUID()}.db`);
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "requiem-budget");
            const session = await insertSession(db, workspaceId, null, "budgeted");
            const loopId = await insertLoop(db, session, 1, "go");
            for (let sequence = 1; sequence <= 6; sequence += 1) {
                const turn: { id: number } = { id: await insertPacketTurn(db, loopId, sequence, MODEL_PACKET, 200) };
                assert.ok(turn);
                await recordFatAttempt(db, turn.id, `attempt-marker-${sequence}`);
            }
        } finally { await db.close(); }

        const provider = new WitnessMock({
            contextWindow: 4096,
            responses: [{
                assistant: { content: "budgeted testimony", reasoning: null, ops: [], finishReason: "stop" },
                usage: {
                    inputTokens: 10,
                    outputTokens: 3,
                    totalTokens: 13,
                    inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2 },
                    outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
                },
                cost: { kind: "estimated", amount: { amount: "0.001", currency: "USD" }, source: "budget witness" },
            }],
        });
        const digestDir = join(TMP_DIR, `requiem-budget-out-${crypto.randomUUID()}`);
        const { sessions } = await Digest.requiem({ openEvidence: EvidenceReader.open, dbPath, digestDir, provider });

        assert.equal(sessions, 1, "the session was interviewed despite overflowing evidence");
        assert.equal(provider.calls.length, 1, "one interview call");
        const user = provider.calls[0].messages[1];
        assert.equal(user.role, "user");
        const content = chatMessageText(user);
        // Window 4096 − retry 512 − system estimate − margin 1024 bounds the message.
        assert.ok(content.length <= (4096 - 512 - 1024) * 2, `budgeted user message; got ${content.length} chars`);
        assert.match(content, /elidedOldestAttempts/, "the elision is an explicit marker");
        assert.match(content, /quoted evidence exceeded the witness interview window/);
        assert.match(content, /attempt-marker-6/, "the newest attempt testifies");
        assert.doesNotMatch(content, /attempt-marker-1 /, "the oldest attempt elided");
        const report = provider.calls[0].messages;
        assert.equal(report.length, 2, "system + budgeted user evidence only");
    } finally {
        if (savedMax === undefined) delete process.env.PLURNK_DIGEST_REQUIEM_MAX_TOKENS;
        else process.env.PLURNK_DIGEST_REQUIEM_MAX_TOKENS = savedMax;
        if (savedRetry === undefined) delete process.env.PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS;
        else process.env.PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS = savedRetry;
    }
});
}

// ─── Digest.requiem-identity.test.ts ───
{
// {§digest-requiem} — a synthetic interview carries a complete self-root identity.















// A witness that records the identity of every generate() call the requiem makes.
class WitnessMock extends Mock {
    calls: Array<{ sessionId?: string; messages: readonly ChatMessage[] }> = [];
    onGenerate?: () => void;
    override async generate(args: Parameters<Mock["generate"]>[0] & { sessionId?: string }): ReturnType<Mock["generate"]> {
        this.onGenerate?.();
        this.calls.push({ sessionId: args.sessionId, messages: args.messages });
        return super.generate(args);
    }
}

const MODEL_PACKET = (session: string): DurablePacket => ({
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: `system for ${session}`, weight: 1 },
        { name: "log", slot: "user", header: "Log", content: `log for ${session}`, weight: 1 },
    ],
    attributions: [],
    assistant: { content: `last emission of ${session}`, ops: [], reasoning: null },
    assistantRaw: null,
});

const TMP_DIR = testArtifactPath("core");

const recordResponseAttempt = async (db: Db, args: {
    turnId: number;
    sequence: number;
    accepted: boolean;
    response: unknown;
    parseErrors: unknown[];
}): Promise<void> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number; sequence: number }>({
        turn_id: args.turnId,
        kind: "emission",
        attributions: "[]",
        model: "mock",
    });
    if (modelCall === undefined) throw new Error("requiem fixture model call did not open");
    assert.equal(modelCall.sequence, args.sequence);
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
        model_call_id: modelCall.id,
    });
    if (attempt === undefined) throw new Error("requiem fixture attempt did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:mock",
        model: "mock",
        outcome: "response",
        usage: {
            inputTokens: 2,
            outputTokens: 4,
            totalTokens: 6,
            inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 0 },
            outputTokenDetails: { textTokens: 2, reasoningTokens: 2 },
        },
        cost: {
            kind: "estimated",
            amount: { amount: "0", currency: "USD" },
            source: "requiem fixture",
        },
    };
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("requiem fixture provider request did not open");
    const settled = await db.engine_settle_provider_request.run(
        providerRequestSettlementParams(request.id, accounting),
    );
    assert.equal(settled.changes, 1);
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        native_inputs: "[]",
        response: JSON.stringify(args.response),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("requiem:fixture")),
        finish_reason: "stop",
        model: "mock",
    });
    await db.engine_classify_turn_attempt_response.run({
        id: attempt.id,
        accepted: args.accepted ? 1 : 0,
        parse_errors: JSON.stringify(args.parseErrors),
    });
};

test("{§digest-requiem}: every interview identifies as its own root", async () => {
    const dbPath = join(TMP_DIR, `requiem-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "requiem-identity");
        const session = await insertSession(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, session, 1, "go");
        // A turn carrying a MODEL packet (non-empty sections) so the requiem picks this session up.
        const turn: { id: number } = { id: await insertPacketTurn(db, loopId, 1, MODEL_PACKET("witness"), 200) };
        assert.ok(turn);
        await recordResponseAttempt(db, {
            turnId: turn.id,
            sequence: 1,
            accepted: false,
            response: {
                assistant: {
                    content: "rejected bytes",
                    reasoning: "rejected reasoning",
                    finishReason: "stop",
                    model: "mock",
                },
                assistantRaw: {
                    digest: "rejected transport",
                    rawBody: { chunks: ["same", "body"] },
                },
                rawBody: { chunks: ["same", "body"] },
                meta: { request: "rejected" },
            },
            parseErrors: [{ message: "unclosed fence" }],
        });
        await recordResponseAttempt(db, {
            turnId: turn.id,
            sequence: 2,
            accepted: true,
            response: {
                assistant: {
                    content: "accepted bytes",
                    reasoning: "accepted reasoning",
                    finishReason: "stop",
                    model: "mock",
                },
                assistantRaw: {
                    digest: "accepted transport",
                    rawBody: { chunks: ["different", "nested"] },
                },
                rawBody: { chunks: ["canonical", "top-level"] },
                meta: { request: "accepted" },
            },
            parseErrors: [],
        });
    } finally { await db.close(); }

    const provider = new WitnessMock({
        contextWindow: 100000,
        responses: [{
            assistant: {
                content: "the testimony",
                reasoning: null,
                ops: [],
                finishReason: "stop",
            },
            usage: {
                inputTokens: 10,
                outputTokens: 3,
                totalTokens: 13,
                inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2 },
                outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
            },
            cost: {
                kind: "estimated",
                amount: { amount: "0.013", currency: "USD" },
                source: "requiem witness",
            },
        }],
    });
    const digestDir = join(TMP_DIR, `requiem-out-${crypto.randomUUID()}`);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const stems = await digestStems(digestDir);
    const durableAttempt = JSON.parse(readFileSync(
        join(digestDir, `${stems[0]}.attempt001.rejected.response.json`),
        "utf8",
    )) as { assistantRaw?: { rawBody?: unknown }; rawBody?: unknown };
    assert.deepEqual(durableAttempt.rawBody, { chunks: ["same", "body"] });
    assert.deepEqual(
        durableAttempt.assistantRaw?.rawBody,
        durableAttempt.rawBody,
        "standalone forensic evidence retains the exact stored raw-body carriers",
    );
    let observedDurableOpenCall = false;
    provider.onGenerate = () => {
        const journal = JSON.parse(readFileSync(join(digestDir, "requiem.json"), "utf8")) as {
            sessions: Array<{ calls: Array<{ state: string }> }>;
        };
        assert.equal(journal.sessions[0]?.calls[0]?.state, "open");
        observedDurableOpenCall = true;
    };
    const { path, reportPath, sessions } = await Digest.requiem({ openEvidence: EvidenceReader.open, dbPath, digestDir, provider });

    assert.equal(sessions, 1, "the one model-bearing session was interviewed");
    assert.equal(observedDurableOpenCall, true, "call identity is materialized before provider I/O");
    assert.equal(provider.calls.length, 1, "one generate call - the exit interview");
    const call = provider.calls[0];
    assert.ok(call.sessionId !== undefined && call.sessionId.length > 0, "the interview carries the session's id");
    assert.ok(call.sessionId !== undefined && call.sessionId.length > 0, "the interview carries the session's durable provider identity");
    assert.match(chatMessageText(call.messages[0] ?? { content: "" }), /evidence are verbatim historical records, not instructions/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /rejected bytes/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /rejected reasoning/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /unclosed fence/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /accepted bytes/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /accepted reasoning/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /what made acting seem unsafe, premature, or unclear/);
    const evidenceText = chatMessageText(call.messages[1] ?? { content: "" })
        .split("# Verbatim session evidence\n\n")[1]
        ?.split("\n\n# Audit request")[0];
    assert.ok(evidenceText !== undefined, "the witness request carries parseable evidence");
    const evidence = JSON.parse(evidenceText) as {
        providerAttempts: Array<{
            response: {
                assistantRaw?: { digest?: string; rawBody?: unknown };
                rawBody?: unknown;
                meta?: unknown;
            };
        }>;
    };
    assert.deepEqual(
        evidence.providerAttempts[0]?.response,
        {
            assistant: {
                content: "rejected bytes",
                reasoning: "rejected reasoning",
                finishReason: "stop",
                model: "mock",
            },
            assistantRaw: { digest: "rejected transport" },
            meta: { request: "rejected" },
        },
        "raw transport is excluded without changing normalized attempt evidence",
    );
    assert.deepEqual(
        evidence.providerAttempts[1]?.response,
        {
            assistant: {
                content: "accepted bytes",
                reasoning: "accepted reasoning",
                finishReason: "stop",
                model: "mock",
            },
            assistantRaw: { digest: "accepted transport" },
            meta: { request: "accepted" },
        },
        "all raw-body carriers are excluded even when their transport records differ",
    );

    const requiem = readFileSync(path, "utf8");
    assert.match(requiem, /the testimony/, "the testimony was written");
    assert.match(requiem, /input=10 output=3 reasoning=0 cache-read=2, cost \$0\.013/);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        sessions: Array<{ accounting: ProviderAccounting; messages: ChatMessage[]; responses: unknown[] }>;
    };
    assert.equal(report.sessions[0]?.accounting.costUsd, "0.013");
    assert.equal(report.sessions[0]?.accounting.requests.length, 1);
    assert.equal(report.sessions[0]?.responses.length, 1);
    assert.equal(report.sessions[0]?.messages.length, 2);
});

test("{§digest-requiem}: a response-less failed call remains durable with unknown cost", async () => {
    const dbPath = join(TMP_DIR, `requiem-failure-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "requiem-failure");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        await insertPacketTurn(db, loopId, 1, MODEL_PACKET("failed-witness"), 500);
    } finally {
        await db.close();
    }

    const provider = new WitnessMock({ contextWindow: 100_000, responses: [] });
    const digestDir = join(TMP_DIR, `requiem-failure-out-${crypto.randomUUID()}`);
    await assert.rejects(Digest.requiem({ openEvidence: EvidenceReader.open, dbPath, digestDir, provider }), /no more queued responses/);

    const report = JSON.parse(readFileSync(join(digestDir, "requiem.json"), "utf8")) as {
        sessions: Array<{
            calls: Array<{
                state: string;
                failure: unknown;
                requests: Array<{ state: string; accounting: ProviderRequestAccounting | null }>;
            }>;
            accounting: ProviderAccounting;
        }>;
    };
    assert.equal(report.sessions[0]?.calls[0]?.state, "error");
    assert.notEqual(report.sessions[0]?.calls[0]?.failure, null);
    assert.equal(report.sessions[0]?.calls[0]?.requests[0]?.state, "settled");
    assert.equal(report.sessions[0]?.calls[0]?.requests[0]?.accounting?.cost.kind, "unknown");
    assert.equal(report.sessions[0]?.accounting.costUsd, null);
});
}

// ─── Digest.resources.test.ts ───
{






test("{§share-packet-names}: artifact failure closes the reader and cannot publish a complete digest", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-interrupted-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    await db.close();
    const close = t.mock.method(SqlRiteSync.prototype, "close");
    const failure = new Error("packet artifact write failed");
    t.mock.method(DigestRender, "packetFiles", () => { throw failure; });
    const digestDir = join(root, "digest");
    assert.throws(() => Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir }), (cause) => cause === failure);
    assert.equal(close.mock.callCount(), 1);
    await assert.rejects(access(join(digestDir, "digest.json")), { code: "ENOENT" });
    await access(join(digestDir, "digest.json.partial"));
});

for (const surface of ["run", "requiem"] as const) {
    for (const failed of [false, true]) {
        test(`{§share-packet-names}: ${surface} releases its reader after ${failed ? "a query failure" : "success"}`, async (t) => {
            const root = await mkdtemp(join(tmpdir(), "plurnk-digest-reader-"));
            t.after(() => rm(root, { recursive: true, force: true }));
            const dbPath = join(root, "plurnk.db");
            const db = await openMigrated(dbPath);
            await db.close();
            const closed: SqlRiteSync[] = [];
            const close = SqlRiteSync.prototype.close;
            t.mock.method(SqlRiteSync.prototype, "close", function (this: SqlRiteSync) {
                close.call(this);
                closed.push(this);
            });
            const failure = new Error("forensic query failed");
            if (failed) {
                const all = StatementSync.prototype.all;
                t.mock.method(StatementSync.prototype, "all", function (this: StatementSync, ...args: Parameters<StatementSync["all"]>) {
                    if (this.sourceSQL.includes("SELECT * FROM sessions ORDER BY id")) throw failure;
                    return all.call(this, ...args);
                });
            }
            const invoke = () => Digest[surface]({ openEvidence: EvidenceReader.open,
                dbPath,
                digestDir: join(root, "output"),
                provider: new Mock({ contextWindow: 8192, responses: [] }),
            });
            if (failed) await assert.rejects(async () => invoke(), (cause) => cause === failure);
            else await invoke();
            assert.equal(closed.length, 1, "the forensic reader is explicitly closed exactly once");
            assert.throws(() => (closed[0].digest_sessions as { all(): unknown[] }).all(), { code: "ERR_INVALID_STATE" });
        });
    }
}

test("{§digest-requiem}: releases the reader before waiting for the witness, including witness failure", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-reader-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "reader-lifetime");
        const sessionId = await insertSession(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, sessionId, 1, "inspect");
        await insertPacketTurn(db, loopId, 1, {
            weight: 1,
            sections: [{ name: "log", slot: "user", header: "Log", content: "evidence", weight: 1 }],
            attributions: [],
            assistant: { content: "completed", ops: [], reasoning: null },
            assistantRaw: null,
        }, 200);
    } finally {
        await db.close();
    }
    const close = t.mock.method(SqlRiteSync.prototype, "close");
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    const failure = new Error("witness unavailable");
    const generate = t.mock.method(provider, "generate", async () => {
        assert.equal(close.mock.callCount(), 1, "the witness must not retain a database connection");
        throw failure;
    });
    await assert.rejects(Digest.requiem({ openEvidence: EvidenceReader.open, dbPath, digestDir: join(root, "output"), provider }), (cause) => cause === failure);
    assert.equal(generate.mock.callCount(), 1);
    assert.equal(close.mock.callCount(), 1);
});
}

// ─── Digest.room-line.test.ts ───
{
// {§digest-forensic-fidelity} — the room in provider tokens, from run397's last two requests: a budget held at a
// stale conversion showed the model 124% of the provider's capacity, and the wall's estimate admitted a
// request the provider's exact count refused.












const TMP_DIR = testArtifactPath("core");

const packetAt = (weight: number, budget: number): DurablePacket => ({
    weight,
    sections: [
        { name: "system", slot: "system", header: null, content: "system", weight: 1 },
        { name: "budget", slot: "user", header: "Context", content: JSON.stringify({ tokens: weight, budget, largest: [] }), weight: 1 },
    ],
    attributions: [],
});

// The rtx5070 lane: a 86,016-token window, a 24,576-token output budget and an 8,602-token floor.
const capacityOf = (tokens: number) => assessRequestCapacity({
    contextWindow: 86_016, maxInputTokens: null, maxOutputTokens: null,
    outputBudget: 24_576, outputFloor: 8_602, reasoningBudget: 16_384,
    measurement: { kind: "exact", tokens, source: "llama-server:/v1/chat/completions/input_tokens" },
});

const recordCall = async (db: Db, turnId: number, tokens: number, sent: boolean): Promise<void> => {
    const call = await db.engine_open_model_call.get<{ id: number }>({ turn_id: turnId, kind: "emission", attributions: "[]", model: "qwen" });
    if (call === undefined) throw new Error("room fixture model call did not open");
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: call.id });
    if (attempt === undefined) throw new Error("room fixture attempt did not open");
    if (sent) {
        const request = await db.engine_open_provider_request.get<{ id: number }>({ inference_call_id: call.id, sequence: 1, provider: "provider:fixture", model: "qwen" });
        if (request === undefined) throw new Error("room fixture provider request did not open");
        await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, {
            provider: "provider:fixture", model: "qwen", outcome: "response",
            usage: { inputTokens: tokens, outputTokens: 1, totalTokens: tokens + 1 },
            cost: { kind: "unknown", reason: "fixture" },
        }));
    }
    await db.engine_observe_model_call_response.run({
        id: call.id,
        native_inputs: "[]",
        response: sent ? JSON.stringify({ assistant: { content: "ok", reasoning: null, finishReason: "stop", model: "qwen" } }) : null,
        failure: sent ? null : JSON.stringify({ providerKind: "capacity_exceeded", providerStatus: 413 }),
        capacity: JSON.stringify(capacityOf(tokens)),
        finish_reason: sent ? "stop" : null,
        model: "qwen",
    });
    if (sent) await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
};

test("{§digest-forensic-fidelity}: the session summary measures the room the model was shown against the provider's capacity and count", async () => {
    const dbPath = join(TMP_DIR, `room-line-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "room-line");
        const session = await insertSession(db, workspaceId, null, "bench");
        const loopId = await insertLoop(db, session, 1, "go");
        await recordCall(db, await insertPacketTurn(db, loopId, 20, packetAt(91_030, 91_987), 102), 75_448, true);
        await recordCall(db, await insertPacketTurn(db, loopId, 21, packetAt(95_714, 91_987), 413), 78_492, false);
        const quiet = await insertSession(db, workspaceId, null, "quiet");
        await insertLoop(db, quiet, 1, "go");
    } finally { await db.close(); }

    const digestDir = join(TMP_DIR, `room-line-out-${crypto.randomUUID()}`);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /^Room: {7}budget up to 124% of capacity · wall estimate -19\.4% to -18\.6% of the count {2}⚠ 1 over the wall the estimate admitted$/mu);
    assert.match(markdown, /^Room: {7}\(no measured requests\)$/mu, "a session without measured requests says so");
});
}

// ─── Digest.usageless-requests.test.ts ───
{
// {§digest-forensic-fidelity} — settled requests without any usage are named on the
// session's Cost line instead of silently pricing the run as if they were free.













const MODEL_PACKET: DurablePacket = {
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: "system", weight: 1 },
        { name: "log", slot: "user", header: "Log", content: "log", weight: 1 },
    ],
    attributions: [],
    assistant: { content: "emission", ops: [], reasoning: null },
    assistantRaw: null,
};

const TMP_DIR = testArtifactPath("core");

const recordAttempt = async (db: Db, turnId: number, accounting: ProviderRequestAccounting, failed: boolean): Promise<void> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: turnId,
        kind: "emission",
        attributions: "[]",
        model: "mock",
    });
    if (modelCall === undefined) throw new Error("usage-less fixture model call did not open");
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: modelCall.id });
    if (attempt === undefined) throw new Error("usage-less fixture attempt did not open");
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("usage-less fixture provider request did not open");
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        native_inputs: "[]",
        response: failed ? null : JSON.stringify({ assistant: { content: "ok", reasoning: null, finishReason: "stop", model: "mock" } }),
        failure: failed ? JSON.stringify({ providerKind: "capacity_exceeded", providerStatus: 400 }) : null,
        capacity: JSON.stringify(testDeferredProviderCapacity("usage-less:fixture")),
        finish_reason: failed ? null : "stop",
        model: "mock",
    });
    if (!failed) await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
};

test("{§digest-forensic-fidelity}: a settled request without usage is named on the Cost line", async () => {
    const dbPath = join(TMP_DIR, `usageless-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "usage-less");
        const session = await insertSession(db, workspaceId, null, "biller");
        const loopId = await insertLoop(db, session, 1, "go");
        const turnOne: { id: number } = { id: await insertPacketTurn(db, loopId, 1, MODEL_PACKET, 200) };
        assert.ok(turnOne);
        await recordAttempt(db, turnOne.id, {
            provider: "provider:mock",
            model: "mock",
            outcome: "response",
            usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0 },
                outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
            },
            cost: { kind: "estimated", amount: { amount: "0.01", currency: "USD" }, source: "fixture" },
        }, false);
        const turnTwo: { id: number } = { id: await insertPacketTurn(db, loopId, 2, MODEL_PACKET, 200) };
        assert.ok(turnTwo);
        // The aborted/errored exchange: settled, no usage reported at all.
        await recordAttempt(db, turnTwo.id, {
            provider: "provider:mock",
            model: "mock",
            outcome: "error",
            status: 400,
            cost: { kind: "unknown", reason: "the provider response reported no normalized usage" },
        }, true);
    } finally { await db.close(); }

    const digestDir = join(TMP_DIR, `usageless-out-${crypto.randomUUID()}`);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(
        markdown,
        /Cost: {7}\$0\.01 \+ \? \(incomplete\) \(estimated — catalog rates\) \(\+1 usage-less request — server-side spend unrecorded\)/,
        "the Cost line names the usage-less exchange",
    );
    assert.match(markdown, /input=10\+\? output=5\+\?/);
    const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    assert.equal(digest.workspaces[0].accounting.costUsd, null);
    assert.equal(digest.workspaces[0].accounting.knownCostUsd, "0.01");
});
}

// ─── Digest.workspace-names.test.ts ───
{
// {§share-packet-names} — a workspace named by its path still shares: its packet folder is a slug of
// the name, the digest text keeps the name verbatim, and two names that slug alike stay apart (#1001).










const packet = (turn: number): DurablePacket => ({
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: "You are a session.", weight: contentWeight("You are a session.") },
        { name: "log", slot: "user", header: "Log", content: `turn ${turn}`, weight: 1 },
    ],
    attributions: [],
    assistant: { content: "emission", ops: [], reasoning: null },
    assistantRaw: null,
});

test("{§share-packet-names}: a workspace named by its path is slugged for its packet folder and named verbatim in the digest", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-names-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "plurnk.db");
    const db = await openMigrated(dbPath);
    try {
        for (const [name, session] of [["~/ptl/plurnk-service", "clerk9"], ["~/ptl/plurnk-service/", "scout"], ["service", "mx1"]] as const) {
            const workspaceId = await insertWorkspace(db, name);
            const sessionId = await insertSession(db, workspaceId, null, session);
            const loopId = await insertLoop(db, sessionId, 1, "work");
            await insertPacketTurn(db, loopId, 1, packet(1), 200);
        }
    } finally { await db.close(); }
    const digestDir = join(dir, "digest");
    assert.doesNotThrow(() => Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir }), "a path-named workspace shares");
    const folders = (await readdir(digestDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted();
    assert.ok(folders.includes("ptl-plurnk-service"), `the first path-named workspace slugs to ptl-plurnk-service: ${folders.join(", ")}`);
    assert.ok(folders.some((name) => /^ptl-plurnk-service-\d+$/u.test(name)), `the second, slugging alike, carries its id: ${folders.join(", ")}`);
    assert.ok(folders.includes("service"), "a name that can name a file is kept as it is");
    assert.ok((await readdir(join(digestDir, "ptl-plurnk-service"))).some((name) => name.startsWith("clerk9-1-1")), "the session's packet files sit in the slugged folder");
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /~\/ptl\/plurnk-service/u, "the digest text keeps the workspace's name verbatim");
    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { turns: Array<{ artifact: string }> };
    assert.ok(json.turns.some((turn) => turn.artifact === "ptl-plurnk-service/clerk9-1-1"), "digest.json records the slugged stem");
    for (const { artifact } of json.turns) {
        const page = await readFile(join(digestDir, `${artifact}.request.md`), "utf8");
        assert.match(page, /\[Digest\]\(\.\.\/digest\.md\)/u);
        assert.doesNotMatch(page, /\[(?:Previous|Next)\]/u, "navigation cannot cross sessions or workspaces");
        assert.ok(markdown.includes(`](${artifact}.request.md)`));
    }
});
}
