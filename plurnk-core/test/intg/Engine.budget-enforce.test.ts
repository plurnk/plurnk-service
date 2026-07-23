// SPEC §grinder — the budget grinder. The model "behaves" here (a clean SEND each
// turn); these tests exercise the engine's enforcement, not the model. An
// absolute ceiling far below any real packet forces overflow deterministically.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, seedEntryWithChannel } from "./_helpers.ts";

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null }, position: { line: 1, column: 1 },
});
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([sendStmt(200, "ok")]));

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const TINY = 2;          // absolute wall far below any real packet → forces overflow
const WIDE = 1_000_000;  // absolute wall capped to the window → never overflows

// #507 — the envelope is PROVIDER-owned, so the policy ceiling pins via RESERVES against the
// provider's own window: promptBudget = window − reserves keeps an over-policy packet PHYSICALLY
// sendable (the recovery-turn semantics the old env policy-window provided). parseReserve rejects
// 0, so the pin is rr=1 + cr = window − ceiling − 1; a full-window ceiling is window − 2 (immaterial
// to overflow tests). SAFETY (core's one knob) is zeroed file-wide below.
process.env.PLURNK_SERVICE_SAFETY = "0";
const plainEngine = (db: Db): Engine => new Engine({ db, schemes: new SchemeRegistry() });
const RESERVE_KEYS = ["PLURNK_PROVIDERS_REASONING_RESERVE", "PLURNK_PROVIDERS_COMPLETION_RESERVE"] as const;
const mockAt = (ceiling: number, responses: MockResponse[], window = 4096): Mock => {
    const prev = RESERVE_KEYS.map((k) => process.env[k]);
    const cr = Math.max(1, window - ceiling - 1);
    process.env.PLURNK_PROVIDERS_REASONING_RESERVE = "1";
    process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE = String(cr);
    const m = new Mock({ contextWindow: window, responses });
    RESERVE_KEYS.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
    return m;
};
// #507 — the over-budget-but-SENDABLE state (the recovery turn's premise) is the SAFETY gap:
// budget = window − reserves − safety, sendability = window − reserves. Pin safety big → tiny
// policy ceiling with honest physics. Restore via the returned fn.
const pinSafety = (n: number): (() => void) => {
    const p = process.env.PLURNK_SERVICE_SAFETY;
    process.env.PLURNK_SERVICE_SAFETY = String(n);
    return () => { process.env.PLURNK_SERVICE_SAFETY = p ?? "0"; };
};
// null reserves (no envelope claimed) — the #421 no-cap Mock; physics alone bounds it.
const mockNoEnvelope = (window: number, responses: MockResponse[]): Mock => {
    const prev = RESERVE_KEYS.map((k) => process.env[k]);
    RESERVE_KEYS.forEach((k) => delete process.env[k]);
    const m = new Mock({ contextWindow: window, responses });
    RESERVE_KEYS.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
    return m;
};

const envelope = async (db: Db): Promise<{ workspaceId: number; workerId: number; loopId: number }> => {
    const workspaceId = await insertWorkspace(db, `ge-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "go");
    return { workspaceId, workerId, loopId };
};

test("under the ceiling the grinder never fires — nothing is hidden", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const provider = mockAt(4096, okSends(2)); // full-window ceiling — never overflows
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        // Under the ceiling the grinder early-returns before pass 1, so turn 1's
        // log stays shown — it would be hidden only on overflow.
        const log = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number }>({ worker_id: workerId });
        assert.ok(log.some((r) => r.turn_seq === 1), "no overflow → prior turn's log still shown, grinder inert");
    } finally { await db.close(); }
});

test("on overflow the prior turn's log entries are folded to their coordinate", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        // Turn 1 runs under a WIDE ceiling so the model completes and leaves an
        // open SEND (the foisted prompt is now folded by default — §prompt-fold);
        // turn 2 runs under TINY so its accumulated packet overflows and the
        // grinder folds turn 1's open log.
        const engine = plainEngine(db);
        const wideP = mockAt(4096, okSends(1));
        const tinyP = mockAt(TINY, okSends(2));
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number }>({ worker_id: workerId });
        assert.ok(before.some((r) => r.turn_seq === 1 && r.expanded === 1), "turn 1 left an open (expanded=1) log entry");
        await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const after = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number; pathname: string | null }>({ worker_id: workerId });
        // #382 — the prompt frame is grinder-exempt; the grinder folds the prior turn's WORK, not the task.
        const t1 = after.filter((r) => r.turn_seq === 1 && (r as { scheme?: string | null }).scheme !== "prompt");
        assert.ok(t1.length > 0 && t1.every((r) => r.expanded === 0), "prior turn's WORK folded (the exempt prompt stays open) — collapsed to coordinate, not deleted");
    } finally { await db.close(); }
});

test("a PLAN row at the newest boundary survives the overflow fold — the checklist steers the recovery (#465)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        // Turn 1 emits PLAN + SEND under a WIDE ceiling — both land as open (expanded=1) log
        // rows. Turn 2 under TINY overflows: the grinder folds the boundary's WORK (the SEND)
        // while the PLAN — the model's orientation surface — stays OPEN, like errors + prompt.
        const planStmt = { op: "PLAN", suffix: "", signal: null, target: null, lineMarker: null, body: { raw: "1. read the doc\n2. answer" }, position: { line: 1, column: 1 } } as unknown as PlurnkStatement;
        const engine = plainEngine(db);
        const wideP = mockAt(4096, [response([planStmt, sendStmt(200, "ok")])]);
        const tinyP = mockAt(TINY, okSends(1));
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; op: string; expanded: number }>({ worker_id: workerId });
        assert.ok(before.some((r) => r.turn_seq === 1 && r.op === "PLAN" && r.expanded === 1), "turn 1's PLAN landed open");
        await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const after = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; op: string; expanded: number; pathname: string | null }>({ worker_id: workerId });
        const plan = after.find((r) => r.turn_seq === 1 && r.op === "PLAN");
        assert.equal(plan?.expanded, 1, "the PLAN row is grinder-exempt — still OPEN through the fold");
        const folded = after.filter((r) => r.turn_seq === 1 && r.op !== "PLAN" && r.op !== "error" && (r as { scheme?: string | null }).scheme !== "prompt");
        assert.ok(folded.length > 0 && folded.every((r) => r.expanded === 0), "the boundary's non-exempt WORK still folds around the surviving plan");
    } finally { await db.close(); }
});

test("THE DOCTRINE: older history is NEVER grinder-folded — the model alone curates it", async () => {
    // The guard whose absence once let a fold-everything variant run green. Three turns; turn 1's
    // rows are OLD history by turn 3. Overflow at turn 3 folds the newest boundary (turn 2 + turn
    // 3's pre-model rows) and MUST leave turn 1's open rows untouched — even though folding them
    // would help fit. The engine never janitors the model's memory; a model that won't curate
    // strikes out/413s instead. That consequence IS the design.
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const wideP = mockAt(4096, okSends(2));
        const tinyP = mockAt(TINY, okSends(2));
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const openT1before = (await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number }>({ worker_id: workerId }))
            .filter((r) => r.turn_seq === 1 && r.expanded === 1).length;
        assert.ok(openT1before > 0, "precondition: turn 1 left open rows (uncurated history)");
        await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 3 });
        const after = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number }>({ worker_id: workerId });
        assert.equal(after.filter((r) => r.turn_seq === 1 && r.expanded === 1).length, openT1before,
            "turn 1's open rows are UNTOUCHED by the turn-3 grinder fire — history is the model's alone");
        assert.ok(after.filter((r) => r.turn_seq === 2).every((r) => r.expanded === 0),
            "the newest completed turn (2) IS folded — the boundary rule fired");
    } finally { await db.close(); }
});

test("a DECLINED recovery abandons at 413 (budget_overflow) — the terminal that follows being told", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        // Sendable within the 4096 window, over the TINY policy ceiling: recovery turn granted;
        // the model continues without curing it; the second hard overflow is the abort.
        const result = await engine.runLoop({ provider: mockAt(TINY, [response([sendStmt(102, "carrying on")]), response([sendStmt(102, "carrying on")])]), workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.finalStatus, 413, "hard-stop abandons the loop at 413 Content Too Large");
        assert.equal(result.reason, "budget_overflow", "abandonment reason is the budget, not a strike or max-turns");
    } finally { await db.close(); }
});

test("a recovery turn that CONCLUDES is a legitimate 200 — finishing IS a way to stop overflowing", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const restore = pinSafety(4092); // budget = 4096−2−4092 = TINY; sendable to 4094
        try {
            const result = await engine.runLoop({ provider: mockAt(4094, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
            assert.equal(result.finalStatus, 200, "the told model wrapped up — over-policy but done beats dead");
        } finally { restore(); }
    } finally { await db.close(); }
});

test("a grinder fire past the first turn counts toward the strike streak", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const t2 = await engine.runTurn({ provider: mockAt(TINY, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t2.budgetStruck, true, "overflow on turn 2 strikes (model over-subscribed)");
    } finally { await db.close(); }
});

test("turn-1 overflow folds the turn's own foists and STRIKES — no soft exemption", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const restore = pinSafety(4092);
        let t1: Awaited<ReturnType<Engine["runTurn"]>>;
        try { t1 = await engine.runTurn({ provider: mockAt(4094, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 }); } finally { restore(); }
        assert.equal(t1.budgetStruck, true, "every compaction strikes — turn 0/1 is NOT exempt (#4): a fold happened, so it counts");
        // §grinder-hard-413-recovery: the first hard overflow is now the RECOVERY turn (sendable
        // within the 4096 window), not a hard stop — the strike above is what this test pins.
        assert.equal(t1.budgetHardStop, false, "first overflow → recovery turn, not death");
    } finally { await db.close(); }
});

test("overflow is a terse op='error' log row (413) surfaced THIS turn as a LogCoordinate — not a by-scheme JSON event", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const wideP = mockAt(4096, okSends(2));
        const tinyP = mockAt(TINY, okSends(2));
        // Turn 1 under WIDE leaves an open SEND (the foisted prompt is folded by default — §prompt-fold);
        // turn 2 overflows under TINY → the grinder folds that SEND AND mints a terse 'Budget Overflow'
        // op='error' row, re-derived into turn 2's OWN packet (same-turn, not a turn late).
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const t2 = await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row!.packet) as { telemetryErrors: Array<Record<string, unknown>> };
        const evt = packet.telemetryErrors.find((e) => (e.position as { type?: string } | undefined)?.type === "log-coordinate" && e.status === 413);
        assert.ok(evt, "the overflow surfaced THIS turn as a 413 LogCoordinate pointer");
        assert.equal(evt!.folded, undefined, "no by-scheme 'folded' JSON — terseness");
        assert.equal(evt!.layer, undefined, "no mechanism vocabulary — no 'layer'");
    } finally { await db.close(); }
});

test("a huge ENGINE-WRITTEN row on the current turn is part of the newest boundary — folds, never a needless 413 (#332)", async () => {
    // The run14 shape: the prior turn is tiny, and the overflow lives in THIS turn's pre-model
    // rows (a wake turn's auto-surfaced stream conclusion — 68KB of search results). The current
    // turn's pre-model rows are part of the newest turn boundary, so they fold with it and the
    // packet fits — the loop survives to read the folded, re-OPENable row. History is untouched.
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        // Turn 1 — small, real (leaves a tiny open log).
        const engine = plainEngine(db);
        await engine.runTurn({ provider: mockAt(4096, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        // Turn 2 — opened manually; a HUGE OPEN engine-origin row lands on it pre-model (the wake surface).
        const turnId = await insertTurn(db, loopId, 2, 102);
        await (db.engine_insert_log_entry as PrepMethod).get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "plurnk", source: null, op: "READ", suffix: "", signal: null,
            scheme: "search", username: null, password: null, hostname: null, port: null,
            pathname: "/1/1/7", params: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 200, content: "R".repeat(8000) }), mimetype_rx: "application/json",
            status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const { default: TelemetryChannel } = await import("../../src/core/TelemetryChannel.ts");
        const telemetry = new TelemetryChannel({ db });
        // #507 — one builder; the ceiling pins on the PROVIDER (window − reserves): a wide probe
        // measures the open packet, then a provider pinned just under it forces the stage-2 fold.
        const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), telemetry, executors: () => undefined });
        const wideProbe = mockAt(999_998, [], 1_000_000);
        const args = { initialMessages: MESSAGES, requirements: "", workspaceId, workerId, loopId, currentTurnSeq: 2, provider: wideProbe, gitStatus: null };
        const open = await builder.buildRequestPacket(args);
        // Pin the ceiling just under the open packet: only folding the 8KB current-turn row can save it.
        const provider = mockAt(open.tokens - 50, [], 1_000_000);
        args.provider = provider;
        const packet = await builder.buildRequestPacket(args);
        const result = await builder.enforceBudget({
            packet, provider, workerId, loopId, turnId, mintSequence: 99,
            rebuild: () => builder.buildRequestPacket(args),
        });
        assert.equal(result.struck, true, "the compaction struck (one strike for the fire)");
        assert.equal(result.fit, true, "stage 2 folded the current turn's engine row — the packet fits, no 413");
        const rows = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; op: string; expanded: number }>({ worker_id: workerId });
        const bigRow = rows.find((r) => r.turn_seq === 2 && r.op === "READ");
        assert.ok(bigRow !== undefined, "the wake row is still LISTED (folded, not deleted)");
        assert.equal(bigRow.expanded, 0, "the wake row is FOLDED (re-OPENable) — and not fatal");
    } finally { await db.close(); }
});

test("the ceiling is the real window partition (window − reserves), no calibration ratio", async () => {
    const db = await openMigrated();
    try {
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const { default: TelemetryChannel } = await import("../../src/core/TelemetryChannel.ts");
        const telemetry = new TelemetryChannel({ db });
        const b = new PacketBuilder({ db, schemes: new SchemeRegistry(), telemetry, executors: () => undefined });
        // #507 — the provider window drives; reserves 1+1 (parseReserve floor) → ceiling 9998.
        // No ratio: the model-facing measure is the chars/2 ruler, and comparing ruler-weight to
        // this real-token ceiling is the conservative bias (§tokenomics-agnostic-ruler).
        const provider = mockAt(9998, [], 10_000);
        assert.equal(b.ceilingFor(provider), 9998, "ceiling = provider window − reserves, verbatim");
    } finally { await db.close(); }
});

test("the 413 row states the pressure law — fold history first, fetch within the room", async () => {
    // run24/jumbo forensics: the read→grind→re-read spiral happens because the model is never
    // TOLD that an oversized retrieval arrives pre-folded. The 413 is the right slot: the signal
    // fires exactly when the lesson applies. Terse, causal, factual — not an essay.
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const wideP = mockAt(4096, okSends(2));
        const tinyP = mockAt(TINY, okSends(2));
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const t2 = await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row!.packet) as { telemetryErrors: Array<{ status?: number }> };
        assert.ok(packet.telemetryErrors.find((e) => e.status === 413), "the overflow pointer surfaced (terse LogCoordinate)");
        // The text lives in the error ROW the pointer names — what the model actually reads.
        const errRow = await (db.test_error_rows_for_run as PrepMethod).all<{ rx: string }>({ worker_id: workerId });
        const text = errRow.map((r) => r.rx).join(" ");
        assert.match(text, /larger than Tokens Free arrives folded/, "the law rides the signal row");
        assert.match(text, /FOLD older items first/, "the lever is named");
    } finally { await db.close(); }
});

test("a finish=length turn's parse errors are led by the CAUSE — truncation, not syntax (run29)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        // A truncated emission: an unterminated FIND (the guillotine's signature) + finish=length.
        const provider = new Mock({ contextWindow: 100000, responses: [{
            // No pre-parsed ops: the engine parses the (guillotined) content itself; finishReason
            // rides the assistant per the Mock contract.
            assistant: { content: "<<PLAN:big turn:PLAN\n<<FIND(SPEC.md):#grinder", reasoning: null, finishReason: "length", usage: { prompt: 10, completion: 12281, reasoning: 0, cached: 0, total: 12291 } },
        } as never] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const errs = await (db.test_error_rows_for_run as PrepMethod).all<{ rx: string }>({ worker_id: workerId });
        assert.ok(errs.length >= 2, "the truncation row AND the parse artifact both recorded");
        const first = JSON.parse(errs[0]!.rx) as { kind?: string; message?: string };
        assert.equal(first.kind, "output_truncated", "the CAUSE leads");
        assert.match(first.message ?? "", /cut mid-op — the parse errors below are truncation artifacts/, "the cause is stated as FACT — the tail parse errors are artifacts, no remedy menu");
        assert.match(errs.map((e) => e.rx).join(" "), /never closed/, "the parse artifacts stay — the record never hides");
    } finally { await db.close(); }
});

test("a finish=length turn that emitted NOTHING — reasoning ran away — is led by the empty-emission cause, not a syntax lie (run52)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        // The runaway-reasoning shape (run52 T33/T71): the whole decode pool went to reasoning, content
        // EMPTY, guillotined at the cap. The parser sees empty content → "must begin with PLAN" — a red
        // herring the model must NOT read as a structure mistake; the 413 leads and frames it.
        const provider = new Mock({ contextWindow: 100000, responses: [{
            assistant: { content: "", reasoning: "ran away reasoning for the whole pool", finishReason: "length", usage: { prompt: 10, completion: 65536, reasoning: 0, cached: 0, total: 65546 } },
        } as never] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const errs = await (db.test_error_rows_for_run as PrepMethod).all<{ rx: string }>({ worker_id: workerId });
        assert.ok(errs.length >= 2, "the truncation row AND the empty-emission parse artifact both recorded — the record never hides");
        const first = JSON.parse(errs[0]!.rx) as { kind?: string; message?: string };
        assert.equal(first.kind, "output_truncated", "the CAUSE leads");
        assert.match(first.message ?? "", /nothing was emitted before the pool was consumed/, "the empty-emission cause is stated — the model emitted zero ops, so 'emit fewer' would be a lie");
        assert.doesNotMatch(first.message ?? "", /cut mid-op|emit fewer ops/, "no mid-op framing — there was no emission to cut");
        assert.match(errs.map((e) => e.rx).join(" "), /a turn must begin with/, "the red-herring parse artifact stays — the record never hides; the 413 reframes it, never suppresses it");
    } finally { await db.close(); }
});

test("SAFETY resolves PER ALIAS — the suffix wins over the bare fallback (#352, #507)", async () => {
    // #507 — the envelope (window + reserves) is provider-owned and its per-alias resolution is
    // the provider tier's (tested there). Core's per-alias surface is ONE knob: SAFETY, the ruler's
    // packing margin. Driven through the REAL alias resolution: a Mock carries no provider→alias
    // side-table entry, so #partitionFor falls back to resolveActiveAlias(process.env).alias.
    const db = await openMigrated();
    try {
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const { default: TelemetryChannel } = await import("../../src/core/TelemetryChannel.ts");
        const telemetry = new TelemetryChannel({ db });
        const keys = ["PLURNK_MODEL", "PLURNK_MODEL_rig", "PLURNK_SERVICE_SAFETY", "PLURNK_SERVICE_SAFETY_rig"];
        const prev = keys.map((k) => process.env[k]);
        try {
            process.env.PLURNK_SERVICE_SAFETY = "1024";
            delete process.env.PLURNK_MODEL; delete process.env.PLURNK_MODEL_rig; delete process.env.PLURNK_SERVICE_SAFETY_rig;
            const bare = new PacketBuilder({ db, schemes: new SchemeRegistry(), telemetry, executors: () => undefined });
            const p1 = mockAt(8192 - 2, [], 8192); // rr=1, cr=1
            assert.equal(bare.promptBudgetFor(p1), 8192 - 1 - 1 - 1024, "no alias → the bare SAFETY margin applies");
            process.env.PLURNK_MODEL = "rig"; process.env.PLURNK_MODEL_rig = "openai/local.gguf";
            process.env.PLURNK_SERVICE_SAFETY_rig = "64";
            const rig = new PacketBuilder({ db, schemes: new SchemeRegistry(), telemetry, executors: () => undefined });
            const p2 = mockAt(8192 - 2, [], 8192);
            assert.equal(rig.promptBudgetFor(p2), 8192 - 1 - 1 - 64, "the active alias's suffixed SAFETY wins over bare");
        } finally {
            keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
        }
    } finally { await db.close(); }
});

test("the FIRST hard overflow is a RECOVERY TURN — steer minted, generate runs, strike counted; the SECOND terminates 413", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        // Physically sendable (window 200k >> the packet) but hopelessly over the policy ceiling:
        // the SAFETY pin holds the budget at ~TINY while sendability stays 199,998. The model gets
        // its ONE told-and-heard turn, CONTINUES (102) without curing it — the second hard overflow
        // then dies honestly. (A recovery turn that CONCLUDES 200 is legitimate.)
        const restore = pinSafety(199_990);
        const mock = mockAt(199_998, [response([sendStmt(102, "still working")]), response([sendStmt(102, "still working")]), response([sendStmt(102, "still working")])], 200_000);
        let result: Awaited<ReturnType<Engine["runLoop"]>>;
        try { result = await engine.runLoop({ provider: mock, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 }); } finally { restore(); }
        assert.equal(result.finalStatus, 413, "still terminates 413 — the model was told and (structurally) could not comply");
        assert.equal(result.reason, "budget_overflow");
        assert.equal(mock.remaining, 2, "generate ran EXACTLY once — the recovery turn happened; the second overflow skipped the LLM");
        const errs = await (db.test_error_rows_for_run as PrepMethod).all<{ rx: string }>({ worker_id: workerId });
        const steer = errs.map((e) => JSON.parse(e.rx) as { kind?: string; message?: string }).find((e) => e.kind === "budget_overflow" && (e.message ?? "").includes("recovery turn"));
        assert.ok(steer, "the recovery steer was minted — over-budget, the remedy (KILL/FOLD history), and the consequence, stated");
    } finally { await db.close(); }
});

test("physically unsendable → 413 IMMEDIATELY, no recovery generate — physics doesn't negotiate", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        // A 4-token window with an honest 2-token decode envelope: no packet fits window − decode —
        // the packet cannot reach the model at all, and physics does not negotiate.
        const mock = mockAt(TINY, okSends(3), 4);
        const result = await engine.runLoop({ provider: mock, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.finalStatus, 413);
        assert.equal(mock.remaining, 3, "generate never ran — an unsendable packet earns no recovery turn");
    } finally { await db.close(); }
});
