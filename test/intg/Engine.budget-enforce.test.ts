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
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, seedEntryWithChannel } from "./_helpers.ts";

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

// Construct an engine pinned to an exact prompt budget: CTX = the pin, zero reserves —
// promptBudget IS the pin (§tokenomics-window-partition; the settable ceiling is retired).
// Set → construct (reads env) → restore is synchronous, so no cross-test race.
const engineAt = (db: Db, ceiling: number): Engine => {
    const prev = ["CTX", "REASONING", "ASSISTANT", "SAFETY"].map((k) => process.env[`PLURNK_SERVICE_${k}`]);
    process.env.PLURNK_SERVICE_CTX = String(ceiling);
    process.env.PLURNK_SERVICE_REASONING = "0";
    process.env.PLURNK_SERVICE_ASSISTANT = "0";
    process.env.PLURNK_SERVICE_SAFETY = "0";
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    ["CTX", "REASONING", "ASSISTANT", "SAFETY"].forEach((k, i) => {
        if (prev[i] === undefined) delete process.env[`PLURNK_SERVICE_${k}`]; else process.env[`PLURNK_SERVICE_${k}`] = prev[i];
    });
    return engine;
};

const envelope = async (db: Db): Promise<{ sessionId: number; runId: number; loopId: number }> => {
    const sessionId = await insertSession(db, `ge-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "go");
    return { sessionId, runId, loopId };
};

test("[§grinder-overflow-only] under the ceiling the grinder never fires — nothing is hidden", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: 4096, responses: okSends(2) });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        // Under the ceiling the grinder early-returns before pass 1, so turn 1's
        // log stays shown — it would be hidden only on overflow.
        const log = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number }>({ run_id: runId });
        assert.ok(log.some((r) => r.turn_seq === 1), "no overflow → prior turn's log still shown, grinder inert");
    } finally { await db.close(); }
});

test("[§grinder-layer1-rollback] on overflow the prior turn's log entries are folded to their coordinate", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        // Turn 1 runs under a WIDE ceiling so the model completes and leaves an
        // open SEND (the foisted prompt is now folded by default — §prompt-fold);
        // turn 2 runs under TINY so its accumulated packet overflows and the
        // grinder folds turn 1's open log.
        const wide = engineAt(db, WIDE);
        const tiny = engineAt(db, TINY);
        const provider = new Mock({ contextSize: 4096, responses: okSends(3) });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number }>({ run_id: runId });
        assert.ok(before.some((r) => r.turn_seq === 1 && r.expanded === 1), "turn 1 left an open (expanded=1) log entry");
        await tiny.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const after = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number; pathname: string | null }>({ run_id: runId });
        // #382 — the prompt frame is grinder-exempt; the grinder folds the prior turn's WORK, not the task.
        const t1 = after.filter((r) => r.turn_seq === 1 && !(r.pathname ?? "").startsWith("/prompt/"));
        assert.ok(t1.length > 0 && t1.every((r) => r.expanded === 0), "prior turn's WORK folded (the exempt prompt stays open) — collapsed to coordinate, not deleted");
    } finally { await db.close(); }
});

test("[§grinder-layer1-rollback] THE DOCTRINE: older history is NEVER grinder-folded — the model alone curates it", async () => {
    // The guard whose absence once let a fold-everything variant run green. Three turns; turn 1's
    // rows are OLD history by turn 3. Overflow at turn 3 folds the newest boundary (turn 2 + turn
    // 3's pre-model rows) and MUST leave turn 1's open rows untouched — even though folding them
    // would help fit. The engine never janitors the model's memory; a model that won't curate
    // strikes out/413s instead. That consequence IS the design.
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: 4096, responses: okSends(4) });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const openT1before = (await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number }>({ run_id: runId }))
            .filter((r) => r.turn_seq === 1 && r.expanded === 1).length;
        assert.ok(openT1before > 0, "precondition: turn 1 left open rows (uncurated history)");
        await engineAt(db, TINY).runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 3 });
        const after = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number }>({ run_id: runId });
        assert.equal(after.filter((r) => r.turn_seq === 1 && r.expanded === 1).length, openT1before,
            "turn 1's open rows are UNTOUCHED by the turn-3 grinder fire — history is the model's alone");
        assert.ok(after.filter((r) => r.turn_seq === 2).every((r) => r.expanded === 0),
            "the newest completed turn (2) IS folded — the boundary rule fired");
    } finally { await db.close(); }
});

test("[§grinder-hard-413-abort] a DECLINED recovery abandons at 413 (budget_overflow) — the terminal that follows being told", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        // Sendable within the 4096 window, over the TINY policy ceiling: recovery turn granted;
        // the model continues without curing it; the second hard overflow is the abort.
        const result = await engine.runLoop({ provider: new Mock({ contextSize: 4096, responses: [response([sendStmt(102, "carrying on")]), response([sendStmt(102, "carrying on")])] }), sessionId, runId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.finalStatus, 413, "hard-stop abandons the loop at 413 Content Too Large");
        assert.equal(result.reason, "budget_overflow", "abandonment reason is the budget, not a strike or max-turns");
    } finally { await db.close(); }
});

test("[§grinder-hard-413-recovery] a recovery turn that CONCLUDES is a legitimate 200 — finishing IS a way to stop overflowing", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const result = await engine.runLoop({ provider: new Mock({ contextSize: 4096, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.finalStatus, 200, "the told model wrapped up — over-policy but done beats dead");
    } finally { await db.close(); }
});

test("[§grinder-strike-coupling] a grinder fire past the first turn counts toward the strike streak", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const t2 = await engine.runTurn({ provider: new Mock({ contextSize: 4096, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t2.budgetStruck, true, "overflow on turn 2 strikes (model over-subscribed)");
    } finally { await db.close(); }
});

test("[§grinder-compaction-strikes] turn-1 overflow folds the turn's own foists and STRIKES — no soft exemption", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const t1 = await engine.runTurn({ provider: new Mock({ contextSize: 4096, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(t1.budgetStruck, true, "every compaction strikes — turn 0/1 is NOT exempt (#4): a fold happened, so it counts");
        // §grinder-hard-413-recovery: the first hard overflow is now the RECOVERY turn (sendable
        // within the 4096 window), not a hard stop — the strike above is what this test pins.
        assert.equal(t1.budgetHardStop, false, "first overflow → recovery turn, not death");
    } finally { await db.close(); }
});

test("[§grinder-overflow-error-row] overflow is a terse op='error' log row (413) surfaced THIS turn as a LogCoordinate — not a by-scheme JSON event", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const tiny = engineAt(db, TINY);
        const provider = new Mock({ contextSize: 4096, responses: okSends(4) });
        // Turn 1 under WIDE leaves an open SEND (the foisted prompt is folded by default — §prompt-fold);
        // turn 2 overflows under TINY → the grinder folds that SEND AND mints a terse 'Budget Overflow'
        // op='error' row, re-derived into turn 2's OWN packet (same-turn, not a turn late).
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const t2 = await tiny.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row!.packet) as { telemetryErrors: Array<Record<string, unknown>> };
        const evt = packet.telemetryErrors.find((e) => (e.position as { type?: string } | undefined)?.type === "log-coordinate" && e.status === 413);
        assert.ok(evt, "the overflow surfaced THIS turn as a 413 LogCoordinate pointer");
        assert.equal(evt!.folded, undefined, "no by-scheme 'folded' JSON — terseness");
        assert.equal(evt!.layer, undefined, "no mechanism vocabulary — no 'layer'");
    } finally { await db.close(); }
});

test("[§grinder-layer1-rollback] a huge ENGINE-WRITTEN row on the current turn is part of the newest boundary — folds, never a needless 413 (#332)", async () => {
    // The run14 shape: the prior turn is tiny, and the overflow lives in THIS turn's pre-model
    // rows (a wake turn's auto-surfaced stream conclusion — 68KB of search results). The current
    // turn's pre-model rows are part of the newest turn boundary, so they fold with it and the
    // packet fits — the loop survives to read the folded, re-OPENable row. History is untouched.
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        // Turn 1 — small, real (leaves a tiny open log).
        const wide = engineAt(db, WIDE);
        await wide.runTurn({ provider: new Mock({ contextSize: 4096, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        // Turn 2 — opened manually; a HUGE OPEN engine-origin row lands on it pre-model (the wake surface).
        const turnId = await insertTurn(db, loopId, 2, 102);
        await (db.engine_insert_log_entry as PrepMethod).get({
            run_id: runId, loop_id: loopId, turn_id: turnId, sequence: 1,
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
        const provider = new Mock({ contextSize: 1_000_000, responses: [] });
        const buildAt = (ctx: number): InstanceType<typeof PacketBuilder> => {
            const prev = ["CTX", "REASONING", "ASSISTANT", "SAFETY"].map((k) => process.env[`PLURNK_SERVICE_${k}`]);
            process.env.PLURNK_SERVICE_CTX = String(ctx);
            process.env.PLURNK_SERVICE_REASONING = "0"; process.env.PLURNK_SERVICE_ASSISTANT = "0"; process.env.PLURNK_SERVICE_SAFETY = "0";
            const b = new PacketBuilder({ db, schemes: new SchemeRegistry(), telemetry, executors: () => undefined });
            ["CTX", "REASONING", "ASSISTANT", "SAFETY"].forEach((k, i) => { if (prev[i] === undefined) delete process.env[`PLURNK_SERVICE_${k}`]; else process.env[`PLURNK_SERVICE_${k}`] = prev[i]; });
            return b;
        };
        const args = { initialMessages: MESSAGES, requirements: "", sessionId, runId, loopId, currentTurnSeq: 2, provider, gitStatus: null };
        const open = await buildAt(WIDE).buildRequestPacket(args);
        // Pin the ceiling just under the open packet: only folding the 8KB current-turn row can save it.
        const builder = buildAt(open.tokens - 50);
        const packet = await builder.buildRequestPacket(args);
        const result = await builder.enforceBudget({
            packet, provider, runId, loopId, turnId, mintSequence: 99,
            rebuild: () => builder.buildRequestPacket(args),
        });
        assert.equal(result.struck, true, "the compaction struck (one strike for the fire)");
        assert.equal(result.fit, true, "stage 2 folded the current turn's engine row — the packet fits, no 413");
        const rows = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; op: string; expanded: number }>({ run_id: runId });
        const bigRow = rows.find((r) => r.turn_seq === 2 && r.op === "READ");
        assert.ok(bigRow !== undefined, "the wake row is still LISTED (folded, not deleted)");
        assert.equal(bigRow.expanded, 0, "the wake row is FOLDED (re-OPENable) — and not fatal");
    } finally { await db.close(); }
});

test("[§tokenomics-ceiling-calibrates-to-usage] the floor is exact-only — an upper-bound ruler's ceiling expands to observed truth (run24)", async () => {
    const db = await openMigrated();
    try {
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const { default: TelemetryChannel } = await import("../../src/core/TelemetryChannel.ts");
        const telemetry = new TelemetryChannel({ db });
        const prev = ["CTX", "REASONING", "ASSISTANT", "SAFETY"].map((k) => process.env[`PLURNK_SERVICE_${k}`]);
        process.env.PLURNK_SERVICE_CTX = "10000";
        process.env.PLURNK_SERVICE_REASONING = "0"; process.env.PLURNK_SERVICE_ASSISTANT = "0"; process.env.PLURNK_SERVICE_SAFETY = "0";
        const b = new PacketBuilder({ db, schemes: new SchemeRegistry(), telemetry, executors: () => undefined });
        ["CTX", "REASONING", "ASSISTANT", "SAFETY"].forEach((k, i) => { if (prev[i] === undefined) delete process.env[`PLURNK_SERVICE_${k}`]; else process.env[`PLURNK_SERVICE_${k}`] = prev[i]; });
        const provider = new Mock({ contextSize: 1_000_000, responses: [] });
        assert.equal(b.ceilingFor(provider, 1), 10000);
        assert.equal(b.ceilingFor(provider, 0.5), 20000, "ratio 0.5 (a 2× overmeasuring ruler) DOUBLES the measured-space ceiling — real usage lands on the true budget");
        assert.equal(b.ceilingFor(provider, 2), 5000, "the tightening lane is unchanged");
        assert.throws(() => b.ceilingFor(provider, 0), /tokenRatio must be > 0/, "a nonsense ratio fails hard");
    } finally { await db.close(); }
});

test("[§tokenomics-ceiling-calibrates-to-usage] a two-turn inexact loop calibrates DOWN from usage ground truth — run24's strangulation is unreachable", async () => {
    // Turn 1's response reports usage.prompt FAR below the measured packet (the chars/2 ruler's
    // signature — the Mock has no exact tokenizer, so the gauge is inexact). Old semantics pinned
    // the ratio at 1 forever; the ruled fix stores the observed ratio, so turn 2's measured-space
    // ceiling expands and a packet that would have overflowed the strangled budget builds clean.
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        // Turn 1 fits at ratio 1 (no grind, provider called, usage observed). Turn 1's READ pulls
        // a big entry whose rx renders OPEN in turn 2's packet — heavy enough to overflow a
        // ratio-1 ceiling; the calibrated ratio (usage.prompt=1 → observed « 1) expands past it.
        const engine = engineAt(db, 5000);
        const filler = Array.from({ length: 600 }, (_, i) => `line ${i} of padding content for the ratio scenario`).join("\n");
        await seedEntryWithChannel(db, { sessionId, scheme: "known", pathname: "/big.md", channel: "body", content: filler, mimetype: "text/markdown", state: "static" });
        const tinyUsage = (ops: PlurnkStatement[]): MockResponse => ({
            assistant: { content: "", ops, reasoning: null, usage: { prompt: 1, completion: 0, reasoning: 0, cached: 0, total: 1 } },
        });
        const readBig: PlurnkStatement = { op: "READ", suffix: "", signal: null, target: {
            kind: "url", raw: "known:///big.md", scheme: "known",
            username: null, password: null, hostname: null, port: null, pathname: "/big.md", params: {}, fragment: null,
        }, lineMarker: null, body: null, position: { line: 1, column: 1 } } as never;
        const provider = new Mock({ contextSize: 1_000_000, responses: [
            tinyUsage([readBig, sendStmt(102, "t1")]),
            tinyUsage([sendStmt(102, "t2 — the READ rx renders open here")]),
        ] });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row!.packet) as { telemetryErrors?: Array<{ status?: number; position?: { coordinate?: string } }> };
        // Turn 1 MAY overflow (ratio 1, no observation yet — its 413 row re-surfaces as a turn-1
        // coordinate). The ruled behavior: turn 2, calibrated from turn 1's usage ground truth,
        // mints NO overflow of its own.
        const t2Overflow = (packet.telemetryErrors ?? []).find((e) => e.status === 413 && e.position?.coordinate?.startsWith("1/2/") === true);
        assert.equal(t2Overflow, undefined, "no turn-2 budget_overflow: the calibrated-down ratio expanded the measured ceiling to truth");
    } finally { await db.close(); }
});

test("[§tokenomics-fetch-fits-free] the 413 row states the pressure law — fold history first, fetch within the room", async () => {
    // run24/jumbo forensics: the read→grind→re-read spiral happens because the model is never
    // TOLD that an oversized retrieval arrives pre-folded. The 413 is the right slot: the signal
    // fires exactly when the lesson applies. Terse, causal, factual — not an essay.
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const tiny = engineAt(db, TINY);
        const provider = new Mock({ contextSize: 4096, responses: okSends(4) });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const t2 = await tiny.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row!.packet) as { telemetryErrors: Array<{ status?: number }> };
        assert.ok(packet.telemetryErrors.find((e) => e.status === 413), "the overflow pointer surfaced (terse LogCoordinate)");
        // The text lives in the error ROW the pointer names — what the model actually reads.
        const errRow = await (db.test_error_rows_for_run as PrepMethod).all<{ rx: string }>({ run_id: runId });
        const text = errRow.map((r) => r.rx).join(" ");
        assert.match(text, /larger than Tokens Free arrives folded/, "the law rides the signal row");
        assert.match(text, /FOLD older items first/, "the lever is named");
    } finally { await db.close(); }
});

test("[§tokenomics-output-truncated] a finish=length turn's parse errors are led by the CAUSE — truncation, not syntax (run29)", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, WIDE);
        // A truncated emission: an unterminated FIND (the guillotine's signature) + finish=length.
        const provider = new Mock({ contextSize: 100000, responses: [{
            // No pre-parsed ops: the engine parses the (guillotined) content itself; finishReason
            // rides the assistant per the Mock contract.
            assistant: { content: "<<PLAN:big turn:PLAN\n<<FIND(SPEC.md):#grinder", reasoning: null, finishReason: "length", usage: { prompt: 10, completion: 12281, reasoning: 0, cached: 0, total: 12291 } },
        } as never] });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const errs = await (db.test_error_rows_for_run as PrepMethod).all<{ rx: string }>({ run_id: runId });
        assert.ok(errs.length >= 2, "the truncation row AND the parse artifact both recorded");
        const first = JSON.parse(errs[0]!.rx) as { kind?: string; message?: string };
        assert.equal(first.kind, "output_truncated", "the CAUSE leads");
        assert.match(first.message ?? "", /truncation artifacts; emit fewer ops per turn/, "the remedy is the real one — not a syntax fix");
        assert.match(errs.map((e) => e.rx).join(" "), /never closed/, "the parse artifacts stay — the record never hides");
    } finally { await db.close(); }
});

test("[§tokenomics-window-partition] the partition resolves PER ALIAS — the suffix wins over the bare fallback (#352)", async () => {
    // Driven through the REAL alias resolution: a Mock carries no provider->alias side-table
    // entry, so #partitionFor falls back to resolveActiveAlias(process.env).alias — set
    // PLURNK_MODEL to make an alias active and its suffixed knobs win. No production test-hook.
    const db = await openMigrated();
    try {
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const { default: TelemetryChannel } = await import("../../src/core/TelemetryChannel.ts");
        const telemetry = new TelemetryChannel({ db });
        const keys = ["PLURNK_MODEL", "PLURNK_MODEL_rig",
            "PLURNK_SERVICE_CTX", "PLURNK_SERVICE_REASONING", "PLURNK_SERVICE_ASSISTANT", "PLURNK_SERVICE_SAFETY",
            "PLURNK_SERVICE_CTX_rig", "PLURNK_SERVICE_REASONING_rig", "PLURNK_SERVICE_ASSISTANT_rig", "PLURNK_SERVICE_SAFETY_rig"];
        const prev = keys.map((k) => process.env[k]);
        process.env.PLURNK_SERVICE_CTX = "163840"; process.env.PLURNK_SERVICE_REASONING = "16384";
        process.env.PLURNK_SERVICE_ASSISTANT = "49152"; process.env.PLURNK_SERVICE_SAFETY = "1024";
        try {
            // No active alias → bare (cloud-generous).
            delete process.env.PLURNK_MODEL; delete process.env.PLURNK_MODEL_rig;
            for (const k of ["CTX", "REASONING", "ASSISTANT", "SAFETY"]) delete process.env[`PLURNK_SERVICE_${k}_rig`];
            const bare = new PacketBuilder({ db, schemes: new SchemeRegistry(), telemetry, executors: () => undefined });
            assert.equal(bare.decodeBudget(new Mock({ contextSize: 1_000_000, responses: [] })), 16384 + 49152, "no alias → bare cloud-generous decode envelope");
            // 'rig' active with a tight measured suffix → the suffix wins.
            process.env.PLURNK_MODEL = "rig"; process.env.PLURNK_MODEL_rig = "openai/local.gguf";
            process.env.PLURNK_SERVICE_CTX_rig = "8192"; process.env.PLURNK_SERVICE_REASONING_rig = "1024";
            process.env.PLURNK_SERVICE_ASSISTANT_rig = "2048"; process.env.PLURNK_SERVICE_SAFETY_rig = "64";
            const rig = new PacketBuilder({ db, schemes: new SchemeRegistry(), telemetry, executors: () => undefined });
            const provider = new Mock({ contextSize: 1_000_000, responses: [] });
            assert.equal(rig.decodeBudget(provider), 1024 + 2048, "the active alias's suffixed decode envelope wins over bare");
            assert.equal(rig.promptBudgetFor(provider), 8192 - 1024 - 2048 - 64, "the suffixed window drives the prompt budget");
        } finally {
            keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
        }
    } finally { await db.close(); }
});

test("[§grinder-hard-413-recovery] the FIRST hard overflow is a RECOVERY TURN — steer minted, generate runs, strike counted; the SECOND terminates 413", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        // Physically sendable (window 200k >> the packet) but hopelessly over the policy ceiling
        // (TINY=2): the model gets its ONE told-and-heard turn. It CONTINUES (102) without curing
        // the overflow — the second hard overflow then dies honestly. (A recovery turn that
        // CONCLUDES 200 is legitimate — finishing IS a way to stop overflowing.)
        const mock = new Mock({ contextSize: 200_000, responses: [response([sendStmt(102, "still working")]), response([sendStmt(102, "still working")]), response([sendStmt(102, "still working")])] });
        const result = await engine.runLoop({ provider: mock, sessionId, runId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.finalStatus, 413, "still terminates 413 — the model was told and (structurally) could not comply");
        assert.equal(result.reason, "budget_overflow");
        assert.equal(mock.remaining, 2, "generate ran EXACTLY once — the recovery turn happened; the second overflow skipped the LLM");
        const errs = await (db.test_error_rows_for_run as PrepMethod).all<{ rx: string }>({ run_id: runId });
        const steer = errs.map((e) => JSON.parse(e.rx) as { kind?: string; message?: string }).find((e) => e.kind === "budget_overflow" && (e.message ?? "").includes("recovery turn"));
        assert.ok(steer, "the recovery steer was minted — over-budget, the remedy (KILL/FOLD history), and the consequence, stated");
    } finally { await db.close(); }
});

test("[§grinder-hard-413-recovery] physically unsendable → 413 IMMEDIATELY, no recovery generate — physics doesn't negotiate", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        // A 1-token provider window: the packet cannot reach the model at all.
        const mock = new Mock({ contextSize: 1, responses: okSends(3) });
        const result = await engine.runLoop({ provider: mock, sessionId, runId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.finalStatus, 413);
        assert.equal(mock.remaining, 3, "generate never ran — an unsendable packet earns no recovery turn");
    } finally { await db.close(); }
});
