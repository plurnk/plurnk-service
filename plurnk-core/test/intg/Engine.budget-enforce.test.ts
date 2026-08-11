// SPEC {§grinder} — the budget grinder. The model "behaves" here (a clean SEND each
// turn); these tests exercise the engine's enforcement, not the model. An
// absolute ceiling far below any real packet forces overflow deterministically.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, packetSection, seedEntryWithChannel } from "./_helpers.ts";
import { readStmt, urlPath } from "./_dsl.ts";

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

// {§tokenomics-window-partition} — the envelope is provider-owned, so the policy ceiling pins via reserves against the
// provider's own window: promptBudget = window − reserves. parseReserve rejects
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
// {§tokenomics-window-partition} — the negative-ruler-but-admissible state is the SAFETY gap:
// budget = window − reserves − safety, while hard prompt capacity is window − reserves.
// Pin safety high to isolate soft curation pressure. Restore via the returned fn.
const pinSafety = (n: number): (() => void) => {
    const p = process.env.PLURNK_SERVICE_SAFETY;
    process.env.PLURNK_SERVICE_SAFETY = String(n);
    return () => { process.env.PLURNK_SERVICE_SAFETY = p ?? "0"; };
};
// Null reserves (no envelope claimed) exercise {§tokenomics-window-unpollable-deliberate};
// provider capacity alone bounds the request.
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
        const log = await db.engine_render_log.all<{ turn_seq: number }>({ worker_id: workerId });
        assert.ok(log.some((r) => r.turn_seq === 1), "no overflow → prior turn's log still shown, grinder inert");
    } finally { await db.close(); }
});

test("on overflow the prior turn's log entries are folded to their coordinate", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        // Turn 1 runs under a WIDE ceiling so the model completes and leaves an
        // open SEND (the first-class prompt row is grinder-exempt);
        // turn 2 runs under TINY so its accumulated packet overflows and the
        // grinder folds turn 1's open log.
        const engine = plainEngine(db);
        const wideP = mockAt(4096, okSends(1));
        const tinyP = mockAt(TINY, okSends(2));
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = await db.engine_render_log.all<{ turn_seq: number; expanded: number }>({ worker_id: workerId });
        assert.ok(before.some((r) => r.turn_seq === 1 && r.expanded === 1), "turn 1 left an open (expanded=1) log entry");
        await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const after = await db.engine_render_log.all<{ turn_seq: number; expanded: number; pathname: string | null }>({ worker_id: workerId });
        // The prompt frame is grinder-exempt. {§grinder-errors-exempt}
        const t1 = after.filter((r) => r.turn_seq === 1 && (r as { scheme?: string | null }).scheme !== "prompt");
        assert.ok(t1.length > 0 && t1.every((r) => r.expanded === 0), "prior turn's WORK folded (the exempt prompt stays open) — collapsed to coordinate, not deleted");
    } finally { await db.close(); }
});

test("a PLAN row at the newest boundary survives the overflow fold", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        // Turn 1 emits PLAN + SEND under a WIDE ceiling — both land as open (expanded=1) log
        // rows. Turn 2 under TINY overflows: the grinder folds the boundary's WORK (the SEND)
        // while the PLAN — the model's orientation surface — stays OPEN, like errors + prompt.
        const planStmt = { op: "PLAN", suffix: "", signal: null, target: null, lineMarker: null, body: "1. read the doc\n2. answer", position: { line: 1, column: 1 } } as PlurnkStatement;
        const engine = plainEngine(db);
        const wideP = mockAt(4096, [response([planStmt, sendStmt(200, "ok")])]);
        const tinyP = mockAt(TINY, okSends(1));
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = await db.engine_render_log.all<{ turn_seq: number; op: string; expanded: number }>({ worker_id: workerId });
        assert.ok(before.some((r) => r.turn_seq === 1 && r.op === "PLAN" && r.expanded === 1), "turn 1's PLAN landed open");
        await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const after = await db.engine_render_log.all<{ turn_seq: number; op: string; expanded: number; pathname: string | null }>({ worker_id: workerId });
        const plan = after.find((r) => r.turn_seq === 1 && r.op === "PLAN");
        assert.equal(plan?.expanded, 1, "the PLAN row is grinder-exempt — still OPEN through the fold");
        const folded = after.filter((r) => r.turn_seq === 1 && r.op !== "PLAN" && r.op !== "error" && (r as { scheme?: string | null }).scheme !== "prompt");
        assert.ok(folded.length > 0 && folded.every((r) => r.expanded === 0), "the boundary's non-exempt WORK still folds around the surviving plan");
    } finally { await db.close(); }
});

test("the grinder never folds older history - the model owns its visibility", async () => {
    // The guard whose absence once let a fold-everything variant run green. Three turns; turn 1's
    // rows are OLD history by turn 3. Overflow at turn 3 folds the newest boundary (turn 2 + turn
    // 3's pre-model rows) and MUST leave turn 1's open rows untouched — even though folding them
    // would help fit. The engine never chooses older history to hide; continued
    // overflow receives an honest hard failure.
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const wideP = mockAt(4096, okSends(2));
        const tinyP = mockAt(TINY, okSends(2));
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const openT1before = (await db.engine_render_log.all<{ turn_seq: number; expanded: number }>({ worker_id: workerId }))
            .filter((r) => r.turn_seq === 1 && r.expanded === 1).length;
        assert.ok(openT1before > 0, "precondition: turn 1 left older open rows");
        await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 3 });
        const after = await db.engine_render_log.all<{ turn_seq: number; expanded: number }>({ worker_id: workerId });
        assert.equal(after.filter((r) => r.turn_seq === 1 && r.expanded === 1).length, openT1before,
            "turn 1's open rows are untouched by the turn-3 grinder fire");
        assert.ok(after.filter((r) => r.turn_seq === 2).every((r) => r.expanded === 0),
            "the newest completed turn (2) IS folded — the boundary rule fired");
    } finally { await db.close(); }
});

test("repeated negative ruler pressure remains soft while the effective context envelope admits the request", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "worker",
            pathname: "/pressure-evidence",
            content: "ordinary retrieval evidence",
        });
        const restore = pinSafety(199_990);
        const provider = mockAt(199_998, [
            response([readStmt(urlPath("worker", "pressure-evidence")), sendStmt(102, "carrying on")]),
            response([readStmt(urlPath("worker", "pressure-evidence")), sendStmt(102, "still carrying on")]),
            response([sendStmt(200, "done")]),
        ], 200_000);
        let result: Awaited<ReturnType<Engine["runLoop"]>>;
        try {
            result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5, maxStrikes: 1, minCycles: 4 });
        } finally {
            restore();
        }
        assert.equal(result.result.status, 200, "ruler debt never becomes a one-turn quota or strike");
        assert.equal(result.reason, "external", "the ordinary terminal disposition remains authoritative");
        assert.equal(provider.remaining, 0, "all three admitted turns reached the provider");
        for (const turnId of result.turnIds) {
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
            const budget = packetSection(JSON.parse(row!.packet), "budget");
            assert.match(budget, /Tokens Free -\d+/, "the model sees honest negative curation pressure");
            assert.equal(budget.match(/Context Token Budget Panic:/gu)?.length, 1, "the pressure instruction is transient and singular");
        }
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.deepEqual(errors, [], "soft pressure creates no durable failure row");
    } finally { await db.close(); }
});

test("negative ruler pressure may conclude cleanly at 200", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const restore = pinSafety(4092); // budget = 4096−2−4092 = TINY; sendable to 4094
        try {
            const result = await engine.runLoop({ provider: mockAt(4094, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
            assert.equal(result.result.status, 200, "curation pressure does not prevent an admitted conclusion");
        } finally { restore(); }
    } finally { await db.close(); }
});

test("automatic pressure folding is visible through overflow tags without minting an error", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        await engine.runTurn({ provider: mockAt(4096, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const restore = pinSafety(199_990);
        let t2: Awaited<ReturnType<Engine["runTurn"]>>;
        try {
            t2 = await engine.runTurn({ provider: mockAt(199_998, okSends(1), 200_000), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        } finally {
            restore();
        }
        assert.equal(t2.status, 200);
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row!.packet);
        assert.match(packetSection(packet, "log"), /"tags":\["overflow"\]/, "the ambient folded row explains why it was folded");
        assert.equal(packetSection(packet, "errors"), "", "soft pressure is not a durable failure");
    } finally { await db.close(); }
});

test("{§grinder-layer1-rollback}: a huge current-turn engine row folds with the newest boundary", async () => {
    // Current-turn pre-model rows fold atomically with the newest boundary; older history is untouched.
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        // Turn 1 — small, real (leaves a tiny open log).
        const engine = plainEngine(db);
        await engine.runTurn({ provider: mockAt(4096, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        // Turn 2 — opened manually; a HUGE OPEN engine-origin row lands on it pre-model (the wake surface).
        const turnId = await insertTurn(db, loopId, 2, 102);
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "plurnk", source: null, op: "READ", suffix: "", signal: null,
            scheme: "search", username: null, password: null, hostname: null, port: null,
            pathname: "/1/1/7", query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 200, content: "R".repeat(8000) }), mimetype_rx: "application/json",
            status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        // {§tokenomics-window-partition} — one builder; the ceiling pins on the provider (window − reserves): a wide probe
        // measures the open packet, then a provider pinned just under it forces the stage-2 fold.
        const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const wideProbe = mockAt(999_998, [], 1_000_000);
        const args = { initialMessages: MESSAGES, workspaceId, workerId, loopId, currentTurnSeq: 2, provider: wideProbe, gitStatus: null };
        const open = await builder.buildRequestPacket(args);
        // Pin the ceiling just under the open packet: only folding the 8KB current-turn row can save it.
        const provider = mockAt(open.tokens - 50, [], 1_000_000);
        args.provider = provider;
        const packet = await builder.buildRequestPacket(args);
        const result = await builder.enforceBudget({
            packet, provider, loopId, turnId,
            rebuild: () => builder.buildRequestPacket(args),
        });
        assert.equal(result.fit, true, "stage 2 folded the current turn's engine row — the packet fits, no 413");
        const rows = await db.engine_render_log.all<{ turn_seq: number; op: string; expanded: number; tags: string }>({ worker_id: workerId });
        const bigRow = rows.find((r) => r.turn_seq === 2 && r.op === "READ");
        assert.ok(bigRow !== undefined, "the wake row is still LISTED (folded, not deleted)");
        assert.equal(bigRow.expanded, 0, "the wake row is FOLDED (re-OPENable) — and not fatal");
        assert.deepEqual(JSON.parse(bigRow.tags), ["overflow"], "the automatic fold stamps its canonical reason tag");
        assert.match(packetSection(result.packet, "log"), /"tags":\["overflow"\]/, "the rebuilt ambient projection exposes the persisted tag");
        const errorRows = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.deepEqual(errorRows, [], "a successful curation fold does not manufacture a Problem row");
    } finally { await db.close(); }
});

test("the ceiling is the real window partition (window − reserves), no calibration ratio", async () => {
    const db = await openMigrated();
    try {
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const b = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        // {§tokenomics-window-partition} — the provider window drives; reserves 1+1
        // (parseReserve floor) → ceiling 9998.
        // No ratio: the model-facing measure is the chars/2 ruler, and comparing ruler-weight to
        // this real-token ceiling is the conservative bias ({§tokenomics-agnostic-ruler}).
        const provider = mockAt(9998, [], 10_000);
        assert.equal(b.ceilingFor(provider), 9998, "ceiling = provider window − reserves, verbatim");
    } finally { await db.close(); }
});

test("a failed effective context-envelope admission records the exact 413 evidence", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const wideP = mockAt(4096, okSends(2));
        const tinyP = mockAt(TINY, okSends(2));
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const t2 = await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row!.packet);
        assert.match(packetSection(packet, "errors"), /^\* 413 log:\/\/\/.+\/error$/m, "the overflow pointer surfaced (terse LogCoordinate)");
        const errRow = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        const failure = errRow
            .map((row) => JSON.parse(row.rx) as {
                problem?: {
                    type?: string;
                    title?: string;
                    status?: number;
                    detail?: string;
                    usage?: number;
                    ceiling?: number;
                    deficit?: number;
                    stage?: string;
                    retryable?: boolean;
                    contextAdmission?: string;
                    contextCapacity?: number;
                    promptTokens?: number;
                    tokenKind?: string;
                    tokenSource?: string;
                };
            })
            .find((row) => row.problem?.type === "https://problems.plurnk.dev/engine/context/context-envelope-admission-failed")
            ?.problem;
        assert.ok(failure !== undefined);
        assert.equal(failure.title, "Context envelope admission failed");
        assert.equal(failure.status, 413);
        assert.equal(failure.ceiling, TINY);
        assert.ok((failure.usage ?? 0) > TINY);
        assert.equal(failure.deficit, (failure.usage ?? 0) - TINY);
        assert.equal(failure.stage, "context-envelope-admission");
        assert.equal(failure.retryable, false);
        assert.equal(failure.contextAdmission, "over_capacity");
        assert.equal(failure.contextCapacity, TINY);
        assert.ok((failure.promptTokens ?? 0) > TINY);
        assert.equal(failure.tokenKind, "exact");
        assert.equal(failure.tokenSource, "mock:chars2");
        assert.equal(
            failure.detail,
            `The configured context envelope cannot admit this request: exact prompt measurement ${failure.promptTokens} exceeds effective prompt capacity ${failure.contextCapacity}.`,
        );
    } finally { await db.close(); }
});

test("SAFETY resolves per alias — the suffix wins over the bare fallback", async () => {
    // Provider capacity resolves in the provider tier. Core's safety margin also resolves per
    // alias. Driven through the REAL alias resolution: a Mock carries no provider→alias
    // side-table entry, so #partitionFor falls back to resolveActiveAlias(process.env).alias.
    const db = await openMigrated();
    try {
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const keys = ["PLURNK_MODEL", "PLURNK_MODEL_rig", "PLURNK_SERVICE_SAFETY", "PLURNK_SERVICE_SAFETY_rig"];
        const prev = keys.map((k) => process.env[k]);
        try {
            process.env.PLURNK_SERVICE_SAFETY = "1024";
            delete process.env.PLURNK_MODEL; delete process.env.PLURNK_MODEL_rig; delete process.env.PLURNK_SERVICE_SAFETY_rig;
            const bare = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
            const p1 = mockAt(8192 - 2, [], 8192); // rr=1, cr=1
            assert.equal(bare.promptBudgetFor(p1), 8192 - 1 - 1 - 1024, "no alias → the bare SAFETY margin applies");
            process.env.PLURNK_MODEL = "rig"; process.env.PLURNK_MODEL_rig = "openai/local.gguf";
            process.env.PLURNK_SERVICE_SAFETY_rig = "64";
            const rig = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
            const p2 = mockAt(8192 - 2, [], 8192);
            assert.equal(rig.promptBudgetFor(p2), 8192 - 1 - 1 - 64, "the active alias's suffixed SAFETY wins over bare");
        } finally {
            keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
        }
    } finally { await db.close(); }
});

test("virtual PROMPT_BUDGET resolves per alias without changing the provider envelope", async () => {
    const db = await openMigrated();
    try {
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const keys = ["PLURNK_MODEL", "PLURNK_MODEL_rig", "PLURNK_SERVICE_PROMPT_BUDGET", "PLURNK_SERVICE_PROMPT_BUDGET_rig", "PLURNK_SERVICE_SAFETY"];
        const prev = keys.map((key) => process.env[key]);
        try {
            process.env.PLURNK_SERVICE_SAFETY = "0";
            process.env.PLURNK_SERVICE_PROMPT_BUDGET = "7000";
            delete process.env.PLURNK_MODEL;
            delete process.env.PLURNK_MODEL_rig;
            delete process.env.PLURNK_SERVICE_PROMPT_BUDGET_rig;
            const provider = mockAt(8192 - 2, [], 8192);
            const bare = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
            assert.equal(bare.promptBudgetFor(provider), 7000);
            assert.equal(bare.maxTokensFor(provider), 2);

            process.env.PLURNK_MODEL = "rig";
            process.env.PLURNK_MODEL_rig = "openai/local.gguf";
            process.env.PLURNK_SERVICE_PROMPT_BUDGET_rig = "4000";
            const rig = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
            assert.equal(rig.promptBudgetFor(provider), 4000);
            assert.equal(rig.maxTokensFor(provider), 2, "virtual pressure never changes provider generation");
        } finally {
            keys.forEach((key, i) => {
                if (prev[i] === undefined) delete process.env[key];
                else process.env[key] = prev[i];
            });
        }
    } finally {
        await db.close();
    }
});

test("negative ruler pressure preserves the ordinary operation contract", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "worker",
            pathname: "/available-under-pressure",
            content: "ordinary read result",
        });
        const read: PlurnkStatement = {
            op: "READ",
            suffix: "",
            signal: null,
            target: {
                kind: "url",
                raw: "worker:///available-under-pressure",
                scheme: "worker",
                username: null,
                password: null,
                hostname: null,
                port: null,
                pathname: "/available-under-pressure",
                query: null,
                fragment: null,
            },
            lineMarker: null,
            body: null,
            position: { line: 1, column: 1 },
        };
        const restore = pinSafety(199_990);
        try {
            await engine.runTurn({
                provider: mockAt(
                    199_998,
                    [response([read, sendStmt(200, "done")])],
                    200_000,
                ),
                workspaceId,
                workerId,
                loopId,
                messages: MESSAGES,
                turnNumber: 2,
            });
        } finally {
            restore();
        }
        const rows = await db.test_log_entries_by_worker_op_full.all<{
            rx: string;
            status_rx: number;
        }>({
            worker_id: workerId,
            op: "READ",
        });
        const delivered = rows
            .map((row) => ({
                ...row,
                result: JSON.parse(row.rx) as {
                    problem?: {
                        type?: string;
                    };
                    content?: string;
                },
            }))
            .find((row) => row.result.content === "ordinary read result");
        assert.ok(delivered !== undefined, "an ordinary READ executes while the curation gauge is negative");
        assert.equal(delivered.status_rx, 200);
    } finally { await db.close(); }
});

test("a request outside the effective context envelope returns 413 before generation", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        // A 4-token effective envelope with a 2-token generation reserve cannot
        // admit even the packet frame.
        const mock = mockAt(TINY, okSends(3), 4);
        const result = await engine.runLoop({ provider: mock, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.result.status, 413);
        assert.equal(mock.remaining, 3, "generate never ran because admission is final");
        const row = await db.test_get_packet.get<{ packet: string | null }>({ id: result.turnIds[0] });
        assert.ok(row?.packet !== null && row?.packet !== undefined);
        const packet = JSON.parse(row.packet) as Record<string, unknown>;
        assert.equal("assistant" in packet, false, "a hard stop preserves the request without inventing a response");
        assert.equal("assistantRaw" in packet, false, "opaque response evidence exists only after admission");
    } finally { await db.close(); }
});

test("an estimate cannot authorize hard context-envelope admission", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const messages = [MESSAGES[0], { role: "user" as const, content: "漢".repeat(256) }];
        let measuredMessages: readonly { role: string; content: string }[] | undefined;
        const mock = Object.assign(mockAt(199_998, okSends(3), 200_000), {
            countPromptTokens: async (candidate: readonly { role: string; content: string }[]) => {
                measuredMessages = candidate;
                return {
                    kind: "estimate" as const,
                    tokens: Math.ceil(candidate.reduce((sum, message) => sum + message.content.length, 0) / 2),
                    source: "heuristic:chars2",
                    detail: "request framing and serving vocabulary are unknown",
                };
            },
        });
        const restore = pinSafety(199_990);
        let result: Awaited<ReturnType<Engine["runLoop"]>>;
        try {
            result = await engine.runLoop({ provider: mock, workspaceId, workerId, loopId, messages, maxTurns: 5 });
        } finally {
            restore();
        }
        assert.equal(result.result.status, 413);
        assert.equal(mock.remaining, 3, "an empirical estimate cannot authorize generation against a hard envelope");
        assert.deepEqual(
            measuredMessages?.map(({ role }) => role),
            ["system", "user"],
            "context-envelope admission measured the same two rendered slots dispatched by PacketWire",
        );
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        const failure = errors
            .map(({ rx }) => JSON.parse(rx) as {
                problem?: {
                    contextAdmission?: string;
                    tokenKind?: string;
                    tokenSource?: string;
                    detail?: string;
                };
            })
            .find(({ problem }) => problem?.contextAdmission === "estimate")
            ?.problem;
        assert.equal(failure?.tokenKind, "estimate");
        assert.equal(failure?.tokenSource, "heuristic:chars2");
        assert.match(failure?.detail ?? "", /cannot verify the effective context envelope/);
    } finally {
        await db.close();
    }
});

test("a proven prompt-token upper bound can authorize context-envelope admission", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const mock = Object.assign(mockAt(199_998, [response([sendStmt(200, "recovered")])], 200_000), {
            countPromptTokens: async () => ({
                kind: "upper_bound" as const,
                tokens: 1,
                source: "test:proven-request-bound",
            }),
        });
        const restore = pinSafety(199_990);
        let result: Awaited<ReturnType<Engine["runLoop"]>>;
        try {
            result = await engine.runLoop({ provider: mock, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
        } finally {
            restore();
        }
        assert.equal(result.result.status, 200);
        assert.equal(mock.remaining, 0, "the proven bound admits the request to generation");
    } finally {
        await db.close();
    }
});
