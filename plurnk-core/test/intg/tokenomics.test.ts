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
    op: "EDIT", annotation: null, delimiter: "", signal: null,
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
        const m = budget.match(/tokensActiveTotal:\s+(\d+) \(\s*(?:<1|\d+)%\)\ntokensActiveMax:\s+(\d+)/);
        assert.ok(m, `context token budget carries active total and maximum; got: ${budget}`);
        assert.equal(budget.split("\n").length, 2, "the model-facing budget contains exactly two fields");
        const usage = Number(m![1]); const ceiling = Number(m![2]);
        assert.ok(usage > 0, "usage is populated, not zero or a leftover placeholder");
        assert.equal(usage, packet.weight, "displayed usage is the exact persisted request render-weight");
        assert.ok(usage < ceiling, "the admitted packet stays below the displayed maximum");
    } finally { await db.close(); }
});

test("context token budget shows active total as a percent of the maximum", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-pct-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        const m = budget.match(/tokensActiveTotal:\s+(\d+) \(\s*(<1|\d+)%\)\ntokensActiveMax:\s+(\d+)/);
        assert.ok(m, `context token budget carries active percentage; got: ${budget}`);
        const usage = Number(m![1]); const pct = m![2]; const ceiling = Number(m![3]);
        const exact = (usage / ceiling) * 100;
        // The budget-% fix: a positive usage under 1% renders "<1", not a rounded-down 0%.
        if (exact > 0 && exact < 1) {
            assert.equal(pct, "<1", `sub-1% usage renders as <1, not 0%; exact=${exact}`);
        } else {
            assert.equal(Number(pct), Math.round(exact), "percent reconciles to round(usage/ceiling)");
        }
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
            planValue("Automatically FOLD log bodies newly active at token-budget overflow."),
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
