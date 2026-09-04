import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES, packetSection } from "./_helpers.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { planValue, sendStmt } from "./_dsl.ts";
import { contentWeight } from "../../src/core/content-weight.ts";

// {§tokenomics}: entry and log content-depth is stamped at write time in the
// model-independent ruler used by production: ceil(chars/2). Provider-reported
// usage and provider-owned hard context-envelope admission are separate quantities.

const urlPath = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    metadata: null,
    op: "EDIT", annotation: null, delimiter: "",
    target: urlPath(pathname), lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `tok-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "p");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, workerId, loopId, turnId };
};

test("EDIT stores entry_channels.weight from the model-agnostic ruler", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const content = "alpha beta gamma delta";
        const result = await engine.dispatch({
            statement: editStmt("/notes", content),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        }) as { status: number; entryId: number | null };
        assert.equal(result.status, 201);
        assert.ok(result.entryId !== null);
        const ch = await db.tok_channel_weight.get<{ weight: number }>({ entry_id: result.entryId, name: "body" });
        // The write-time stamp is the model-agnostic ruler ({§tokenomics-agnostic-ruler}): ceil(len/2).
        assert.equal(ch?.weight, Math.ceil(content.length / 2));
        assert.ok((ch?.weight ?? 0) > 0, "weight is populated at write, not left at the old hardcoded 0");
    } finally { await db.close(); }
});

test("dispatched op stores log_entries.weight from its complete canonical log body", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        let logEntryId = 0;
        await engine.dispatch({
            statement: editStmt("/x", "hello world"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id: number) => { logEntryId = id; },
        });
        assert.ok(logEntryId > 0, "a log entry was written");
        const row = await db.tok_log_weight.get<{ rx: string; weight: number }>({ id: logEntryId });
        const result = JSON.parse(row?.rx ?? "null") as { receipt?: { effect?: { context?: unknown } } };
        const context = result.receipt?.effect?.context;
        assert.equal(typeof context, "string", "the successful EDIT retains its canonical receipt context");
        assert.equal(row?.weight, contentWeight(context as string));
    } finally { await db.close(); }
});

test("entry_channels.weight honors an injected ruler override (test seam)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-prov-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 200);
        // Inject a distinctive weight (constant 100) — unmistakably not ceil(len/4).
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, weigh: () => 100 });
        let logEntryId = 0;
        const result = await engine.dispatch({
            statement: editStmt("/notes", "alpha beta gamma"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id: number) => { logEntryId = id; },
        }) as { status: number; entryId: number | null };
        const ch = await db.tok_channel_weight.get<{ weight: number }>({ entry_id: result.entryId, name: "body" });
        assert.equal(ch?.weight, 100, "the write stamp honors the injected weight (test seam); production injects the chars/2 ruler");
        const log = await db.tok_log_weight.get<{ weight: number }>({ id: logEntryId });
        assert.equal(log?.weight, 100, "the same injected ruler weighs canonical log content once");
    } finally { await db.close(); }
});

test("context token budget carries a populated active-total/maximum state", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-bud-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row!.packet) as { weight: number };
        const budget = packetSection(packet, "budget");
        const state = JSON.parse(budget) as { tokensActiveTotal: number; tokensActiveMax: number; tokensResponseMax: number };
        assert.deepEqual(Object.keys(state), ["tokensActiveTotal", "tokensActiveMax", "tokensResponseMax"], `context token budget carries active total and maximum; got: ${budget}`);
        assert.equal(budget.split("\n").length, 1, "the model-facing budget is one JSON line");
        const usage = state.tokensActiveTotal; const ceiling = state.tokensActiveMax;
        assert.ok(usage > 0, "usage is populated, not zero or a leftover placeholder");
        assert.equal(usage, packet.weight, "displayed usage is the exact persisted request render-weight");
        assert.ok(usage < ceiling, "the admitted packet stays below the displayed maximum");
    } finally { await db.close(); }
});

test("(#482) overflow tolerance is never advertised: the disclosed allowance stays the configured floor", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-flex-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        const state = JSON.parse(budget) as { tokensResponseMax: number };
        assert.equal(state.tokensResponseMax, provider.outputBudget! - (provider.reasoningBudget ?? 0), "the model plans against its guaranteed program room, whatever the wire may quietly grant");
    } finally { await db.close(); }
});

test("{§output-allowance-notice} tokensResponseMax is the output floor less the reasoning subset", async () => {
    const saved = { out: process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET, reason: process.env.PLURNK_PROVIDERS_REASONING_BUDGET };
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "24576";
    process.env.PLURNK_PROVIDERS_REASONING_BUDGET = "16384";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-room-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 130816, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        assert.equal(provider.outputBudget, 24576); assert.equal(provider.reasoningBudget, 16384);
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        assert.match(budget, /"tokensResponseMax":8192\b/, `thinking spends from the same allowance, so the program is told its real room; got: ${budget}`);
    } finally {
        await db.close();
        if (saved.out === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET; else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = saved.out;
        if (saved.reason === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET; else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = saved.reason;
    }
});

test("context token budget carries active total and maximum without a percent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-pct-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        const state = JSON.parse(budget) as { tokensActiveTotal: number; tokensActiveMax: number };
        assert.ok(Number.isSafeInteger(state.tokensActiveTotal) && state.tokensActiveTotal > 0, "active total is a populated integer");
        assert.ok(Number.isSafeInteger(state.tokensActiveMax) && state.tokensActiveMax > 0, "maximum is a populated integer");
        assert.ok(state.tokensActiveTotal < state.tokensActiveMax, "the admitted packet stays below the displayed maximum");
        assert.doesNotMatch(budget, /%/u, "the readout carries no percent — total and maximum make it derivable");
    } finally { await db.close(); }
});

test("an unrecoverable curation overflow preserves exact pressure evidence in its terminal Problem", async () => {
    const db = await openMigrated();
    const partitionKeys = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const previousPartition = partitionKeys.map((key) => process.env[key]);
    try {
        const workspaceId = await insertWorkspace(db, `tok-over-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        // {§tokenomics-window-partition} — the envelope rides the provider: an
        // 11-token context and a two-token total output budget leave nine input tokens.
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "2";
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // An 11-token provider context − 2 output tokens → input capacity 9; the packet's own
        // scaffolding alone blows past it and cannot be recovered by folding the owned boundary.
        const provider = new Mock({ contextWindow: 11, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.equal(result.status, 413, "un-foldable → hard-413; the loop fails rather than deliver an over-budget packet");
        const turn = await db.test_get_turn.get<{ packet: string | null; producer: string; kind: string }>({ id: result.turnId });
        assert.equal(turn?.packet, null, "an over-ceiling candidate is never stored as a model request");
        assert.deepEqual(
            { producer: turn?.producer, kind: turn?.kind },
            { producer: "_plurnk", kind: "overflow" },
            "the failed recovery remains an explicit _plurnk overflow turn",
        );
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnId });
        const plan = rows.find((row) => row.op === "PLAN" && row.origin === "_plurnk");
        assert.ok(plan, "the recovery records its actual PLAN operation");
        const body = (JSON.parse(plan.tx) as { body: unknown }).body;
        assert.deepEqual(
            body,
            planValue("Automatically KILL log bodies newly active at token-budget overflow."),
            "the recovery PLAN states the ordinary curation action without simulating a packet account",
        );
        const problem = result.curationFailure?.problem as { usage?: number; ceiling?: number; deficit?: number } | undefined;
        assert.ok(problem !== undefined, "the terminal admission failure owns exact pressure evidence");
        const { usage, ceiling, deficit } = problem;
        assert.ok(typeof usage === "number" && typeof ceiling === "number" && typeof deficit === "number");
        assert.ok(usage > ceiling, `usage ${usage} exceeds the ceiling of ${ceiling}`);
        assert.equal(deficit, usage - ceiling, "the deficit reconciles exactly");
    } finally {
        partitionKeys.forEach((key, index) => {
            const previous = previousPartition[index];
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
        await db.close();
    }
});

test("content_hash is a stable per-content identity — identical content, identical hash; no per-model keying", async () => {
    const { contentHash } = await import("../../src/core/content-hash.ts");
    const h = contentHash("same bytes");
    assert.equal(h, contentHash("same bytes"), "deterministic: identical content → identical hash");
    assert.notEqual(h, contentHash("other bytes"), "distinct content → distinct hash");
    assert.match(h, /^[0-9a-f]{64}$/, "a sha256 hex identity");
});

test("{§tokenomics-calibrated-readout} after three reported prompt counts the readout scales to what the model was charged", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-cal-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const reported = 100;
        const charged = { inputTokens: reported, totalTokens: reported };
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "", reasoning: null, ops: [sendStmt(102)] }, usage: charged },
            { assistant: { content: "", reasoning: null, ops: [sendStmt(102)] }, usage: charged },
            { assistant: { content: "", reasoning: null, ops: [sendStmt(102)] }, usage: charged },
            { assistant: { content: "", reasoning: null, ops: [sendStmt(200)] }, usage: charged },
        ] });
        const messages = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "U" }];
        const shown: number[] = [];
        const weights: number[] = [];
        for (let turn = 1; turn <= 4; turn += 1) {
            const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages });
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet) as { weight: number };
            const m = packetSection(packet, "budget").match(/"tokensActiveTotal":\s*(\d+)/);
            assert.ok(m, `turn ${turn} carries a readout`);
            shown.push(Number(m![1]));
            weights.push(packet.weight);
        }
        assert.deepEqual(shown.slice(0, 3), weights.slice(0, 3), "with fewer than three samples the readout is the raw measured weight");
        const factor = (3 * reported) / (weights[0] + weights[1] + weights[2]);
        assert.equal(shown[3], Math.round(weights[3] * factor), `the fourth readout is the measured weight scaled by reported over measured (${factor.toFixed(3)})`);
        assert.notEqual(shown[3], weights[3], "the scaled figure differs from the raw one for this fixture");
    } finally { await db.close(); }
});
