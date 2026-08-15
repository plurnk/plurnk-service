// SPEC {§grinder} — the budget grinder. The model "behaves" here (a clean SEND each
// turn); these tests exercise the engine's enforcement, not the model. An
// absolute ceiling far below any real packet forces overflow deterministically.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock, ProviderError, validateProviderRequestAccounting } from "@plurnk/plurnk-providers";
import type { ChatMessage, MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, packetSection, seedEntryWithChannel } from "./_helpers.ts";
import { foldStmt, openStmt, readStmt, urlPath } from "./_dsl.ts";

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null }, position: { line: 1, column: 1 },
});
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([sendStmt(200, "ok")]));

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const TINY = 2;          // absolute wall far below any real packet → forces overflow
const OVERFLOW_DETAIL = "Token Budget Overflow: Token Usage exceeded Token Ceiling. Newest log items were automatically FOLDed to fit within token budget. Curate the log and/or perform more conservatively scoped or chunked retrieval operations to recover.";

const plainEngine = (db: Db): Engine => new Engine({ db, schemes: new SchemeRegistry() });
class DeferredCapacityMock extends Mock {
    override async countPromptTokens() {
        return {
            kind: "estimate" as const,
            tokens: 1,
            source: "test:deferred-capacity",
            detail: "fixture deliberately leaves physical admission to the upstream mock",
        };
    }
}

const PROMPT_CAPACITY_SENTINEL = "prompt-capacity-recovery-witness";
class UpstreamPromptCapacityMock extends Mock {
    readonly requests: ChatMessage[][] = [];

    override async countPromptTokens(messages: readonly ChatMessage[]) {
        return {
            kind: "estimate" as const,
            tokens: messages.reduce((sum, { content }) => sum + Math.ceil(content.length / 2), 0),
            source: "test:upstream-capacity-oracle",
            detail: "fixture leaves final capacity judgment to the upstream provider",
        };
    }

    override async generate(args: Parameters<Mock["generate"]>[0]): ReturnType<Mock["generate"]> {
        this.requests.push(args.messages.map((message) => ({ ...message })));
        if (args.messages.some(({ content }) => content.includes(PROMPT_CAPACITY_SENTINEL))) {
            const capacity = await this.assessRequestCapacity(args.messages, args.maxOutputTokens);
            const accounting = validateProviderRequestAccounting({
                provider: "provider:mock",
                model: this.model,
                outcome: "error",
                status: 413,
                cost: { kind: "unknown", reason: "upstream rejected the request before generation" },
            });
            const settle = await args.observeRequest?.({ provider: "provider:mock", model: this.model });
            await settle?.(accounting);
            throw new ProviderError(
                "mock",
                "capacity_exceeded",
                "Upstream rejected the projected prompt body as too large.",
                {
                    accounting: [accounting],
                    capacity,
                    extensions: { capacityStage: "upstream" },
                },
            );
        }
        return super.generate(args);
    }
}

const mockAt = (
    capacity: number,
    responses: MockResponse[],
    window = 4096,
    deferPhysicalAdmission = false,
): Mock => {
    const keys = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const previous = keys.map((key) => process.env[key]);
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(Math.max(1, window - Math.min(capacity, window - 1)));
    delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    const ProviderClass = deferPhysicalAdmission ? DeferredCapacityMock : Mock;
    const provider = new ProviderClass({ contextWindow: window, responses });
    keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
    });
    return provider;
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
        const tinyP = mockAt(TINY, okSends(2), 4096, true);
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
        const tinyP = mockAt(TINY, okSends(1), 4096, true);
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
        const tinyP = mockAt(TINY, okSends(2), 4096, true);
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

test("{§grinder-layer1-rollback}: overflow rolls back only the exact older rows newly opened by the completed turn", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const oldTurnId = await insertTurn(db, loopId, 1, 200);
        const seed = async (sequence: number, op: "READ" | "EDIT" | "PLAN", content: string): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: oldTurnId, sequence,
                origin: "model", source: null, model_call_id: null, op, suffix: "", signal: null,
                scheme: "worker", username: null, password: null, hostname: null, port: null,
                pathname: `/old-${sequence}`, query: null, fragment: null, lineMarker: null,
                tx: JSON.stringify({ op }), mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200, content, mimetype: "text/plain", startLine: 1 }),
                mimetype_rx: "application/json", status_rx: 200, weight: 0,
                state: "resolved", outcome: null, attrs: "{}",
            });
            if (row === undefined) throw new Error("old log fixture insert returned no row");
            return row.id;
        };
        const newlyOpenedId = await seed(1, "READ", "R".repeat(8_000));
        const alreadyOpenId = await seed(2, "READ", "small no-op OPEN target");
        const unrelatedId = await seed(3, "EDIT", "unrelated older history");
        const exemptPlanId = await seed(4, "PLAN", "persisted orientation");
        await db.engine_fold_log_entry.run({ id: newlyOpenedId });
        await db.engine_fold_log_entry.run({ id: exemptPlanId });

        const curationLoopId = await insertLoop(db, workerId, 2, "continue");
        const curationTurnId = await insertTurn(db, curationLoopId, 1, 200);
        const opened = await plainEngine(db).dispatch({
            statement: openStmt(urlPath("log", "/**/READ")),
            workspaceId, workerId, loopId: curationLoopId, turnId: curationTurnId, sequence: 1, origin: "model",
        });
        assert.equal(opened.status, 200);
        assert.equal((opened as { matched?: number }).matched, 2, "the one broad OPEN selected both older READ rows");
        const openedPlan = await plainEngine(db).dispatch({
            statement: openStmt(urlPath("log", "/1/1/4/PLAN")),
            workspaceId, workerId, loopId: curationLoopId, turnId: curationTurnId, sequence: 2, origin: "model",
        });
        assert.equal(openedPlan.status, 200);
        const effects = await db.test_log_curation_effects_by_worker.all<{
            target_log_entry_id: number;
            expanded_before: number;
            op: string;
            turn_id: number;
        }>({ worker_id: workerId });
        assert.deepEqual(
            effects.map(({ target_log_entry_id, expanded_before, op, turn_id }) => ({ target_log_entry_id, expanded_before, op, turn_id })),
            [
                { target_log_entry_id: newlyOpenedId, expanded_before: 0, op: "OPEN", turn_id: curationTurnId },
                { target_log_entry_id: alreadyOpenId, expanded_before: 1, op: "OPEN", turn_id: curationTurnId },
                { target_log_entry_id: exemptPlanId, expanded_before: 0, op: "OPEN", turn_id: curationTurnId },
            ],
            "the suppressed event retains its exact selected set and each target's prior visibility",
        );

        const currentTurnId = await insertTurn(db, curationLoopId, 2, 102);
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const wideProbe = mockAt(999_998, [], 1_000_000);
        const args = { initialMessages: MESSAGES, workspaceId, workerId, loopId: curationLoopId, currentTurnSeq: 2, provider: wideProbe, gitStatus: null };
        const openPacket = await builder.buildRequestPacket(args);
        const provider = mockAt(openPacket.weight - 50, [], 1_000_000);
        args.provider = provider;
        let overflowCalls = 0;
        const result = await builder.enforceBudget({
            packet: await builder.buildRequestPacket(args),
            provider,
            loopId: curationLoopId,
            turnId: currentTurnId,
            recordOverflow: async () => { overflowCalls += 1; },
            rebuild: () => builder.buildRequestPacket(args),
        });

        assert.equal(result.fit, true, "rolling back the newly introduced older body makes the packet fit");
        assert.equal(overflowCalls, 1, "one over-ceiling assembly emits one overflow event");
        const rows = await db.engine_render_log.all<{ id: number; expanded: number; tags: string }>({ worker_id: workerId });
        const byId = new Map(rows.map((row) => [row.id, row]));
        assert.equal(byId.get(newlyOpenedId)?.expanded, 0, "the folded-to-open target is rolled back");
        assert.deepEqual(JSON.parse(byId.get(newlyOpenedId)?.tags ?? "[]"), ["overflow"], "the rollback records its reason");
        assert.equal(byId.get(alreadyOpenId)?.expanded, 1, "a no-op OPEN does not make older context grinder-owned");
        assert.deepEqual(JSON.parse(byId.get(alreadyOpenId)?.tags ?? "[]"), [], "the no-op target receives no overflow provenance");
        assert.equal(byId.get(unrelatedId)?.expanded, 1, "unselected older history remains model-owned");
        assert.equal(byId.get(exemptPlanId)?.expanded, 1, "an older PLAN reopened by the boundary remains grinder-exempt");
        assert.deepEqual(JSON.parse(byId.get(exemptPlanId)?.tags ?? "[]"), [], "the exempt PLAN receives no overflow provenance");
    } finally { await db.close(); }
});

test("{§grinder-layer1-rollback}: a reopened target folded again before grinding is not attributed to overflow", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const oldTurnId = await insertTurn(db, loopId, 1, 200);
        const target = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: oldTurnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "READ", suffix: "", signal: null,
            scheme: "worker", username: null, password: null, hostname: null, port: null,
            pathname: "/old", query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 200, content: "old body", mimetype: "text/plain", startLine: 1 }),
            mimetype_rx: "application/json", status_rx: 200, weight: 0,
            state: "resolved", outcome: null, attrs: "{}",
        });
        if (target === undefined) throw new Error("old log fixture insert returned no row");
        await db.engine_fold_log_entry.run({ id: target.id });

        const curationTurnId = await insertTurn(db, loopId, 2, 200);
        const engine = plainEngine(db);
        await engine.dispatch({
            statement: openStmt(urlPath("log", "/1/1/1/READ")),
            workspaceId, workerId, loopId, turnId: curationTurnId, sequence: 1, origin: "model",
        });
        await engine.dispatch({
            statement: foldStmt(urlPath("log", "/1/1/1/READ")),
            workspaceId, workerId, loopId, turnId: curationTurnId, sequence: 2, origin: "model",
        });

        const currentTurnId = await insertTurn(db, loopId, 3, 102);
        await db.engine_grinder_fold_newest_turn({ loop_id: loopId, turn_id: currentTurnId });
        const row = (await db.engine_render_log.all<{ id: number; expanded: number; tags: string }>({ worker_id: workerId }))
            .find(({ id }) => id === target.id);
        assert.equal(row?.expanded, 0, "the model's later FOLD remains authoritative");
        assert.deepEqual(JSON.parse(row?.tags ?? "[]"), [], "the grinder does not claim a row that was already folded");
        const effects = await db.test_log_curation_effects_by_worker.all<{ op: string; expanded_before: number }>({ worker_id: workerId });
        assert.deepEqual(effects.map(({ op, expanded_before }) => ({ op, expanded_before })), [
            { op: "OPEN", expanded_before: 0 },
            { op: "FOLD", expanded_before: 1 },
        ], "both curation events retain their exact prior state");
    } finally { await db.close(); }
});

test("repeated negative curation pressure remains soft when physical admission defers upstream", async () => {
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
        const provider = mockAt(TINY, [
            response([readStmt(urlPath("worker", "pressure-evidence")), sendStmt(102, "carrying on")]),
            response([readStmt(urlPath("worker", "pressure-evidence")), sendStmt(102, "still carrying on")]),
            response([sendStmt(200, "done")]),
        ], 200_000, true);
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5, maxStrikes: 1, minCycles: 4 });
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
        const problems = errors.map(({ rx }) => JSON.parse(rx).problem);
        assert.equal(problems.length, result.turnIds.length, "each actual overflow remains durable even though generation proceeds");
        assert.ok(problems.every((problem) => problem?.status === 413 && problem?.detail === OVERFLOW_DETAIL));
    } finally { await db.close(); }
});

test("negative ruler pressure may conclude cleanly at 200", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const result = await engine.runLoop({ provider: mockAt(TINY, okSends(1), 4096, true), workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.result.status, 200, "curation pressure does not prevent a provider-deferred conclusion");
    } finally { await db.close(); }
});

test("automatic pressure folding is visible through overflow tags and its nonterminal 413 Problem", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        await engine.runTurn({ provider: mockAt(4096, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const t2 = await engine.runTurn({ provider: mockAt(TINY, okSends(1), 200_000, true), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t2.status, 200);
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row!.packet);
        assert.match(packetSection(packet, "log"), /"tags":\["overflow"\]/, "the ambient folded row explains why it was folded");
        assert.match(packetSection(packet, "errors"), /^\* 413 log:\/\/\/.+\/error$/m, "the recovered overflow remains an indexed failure");
        assert.match(packetSection(packet, "log"), new RegExp(OVERFLOW_DETAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
            origin: "plurnk", source: null, model_call_id: null, op: "READ", suffix: "", signal: null,
            scheme: "search", username: null, password: null, hostname: null, port: null,
            pathname: "/1/1/7", query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 200, content: "R".repeat(8000) }), mimetype_rx: "application/json",
            status_rx: 200, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        // {§tokenomics-window-partition} — one builder; the ceiling pins on the provider's derived input capacity: a wide probe
        // measures the open packet, then a provider pinned just under it forces the stage-2 fold.
        const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const wideProbe = mockAt(999_998, [], 1_000_000);
        const args = { initialMessages: MESSAGES, workspaceId, workerId, loopId, currentTurnSeq: 2, provider: wideProbe, gitStatus: null };
        const open = await builder.buildRequestPacket(args);
        // Pin the ceiling just under the open packet: only folding the 8KB current-turn row can save it.
        const provider = mockAt(open.weight - 50, [], 1_000_000);
        args.provider = provider;
        const packet = await builder.buildRequestPacket(args);
        let overflowCalls = 0;
        const result = await builder.enforceBudget({
            packet, provider, loopId, turnId,
            recordOverflow: async () => { overflowCalls += 1; },
            rebuild: () => builder.buildRequestPacket(args),
        });
        assert.equal(result.fit, true, "stage 2 folded the current turn's engine row and the rebuilt packet fits");
        const rows = await db.engine_render_log.all<{ turn_seq: number; op: string; expanded: number; tags: string }>({ worker_id: workerId });
        const bigRow = rows.find((r) => r.turn_seq === 2 && r.op === "READ");
        assert.ok(bigRow !== undefined, "the wake row is still LISTED (folded, not deleted)");
        assert.equal(bigRow.expanded, 0, "the wake row is FOLDED (re-OPENable) — and not fatal");
        assert.deepEqual(JSON.parse(bigRow.tags), ["overflow"], "the automatic fold stamps its canonical reason tag");
        assert.match(packetSection(result.packet, "log"), /"tags":\["overflow"\]/, "the rebuilt ambient projection exposes the persisted tag");
        assert.equal(overflowCalls, 1, "the enforcement owner emits one overflow event for the composed engine to persist");
    } finally { await db.close(); }
});

test("the curation ceiling reuses provider-derived input capacity without a calibration ratio", async () => {
    const db = await openMigrated();
    try {
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const b = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        // {§tokenomics-window-partition} — the provider's resolved input
        // capacity is 9998 under this request envelope.
        // No ratio: the model-facing measure is the chars/2 ruler, and comparing ruler-weight to
        // this real-token ceiling is the conservative bias ({§tokenomics-agnostic-ruler}).
        const provider = mockAt(9998, [], 10_000);
        assert.equal(b.curationBudgetFor(provider), 9998, "curation reuses the provider's derived input capacity verbatim");
    } finally { await db.close(); }
});

test("an exact physical overflow exhausts bounded recovery and preserves provider 413 evidence", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const tinyP = mockAt(TINY, okSends(2));
        const result = await engine.runLoop({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.result.status, 413);
        assert.equal(tinyP.remaining, 2, "preflight rejection issued no physical generation request");
        const turnId = result.turnIds[0]!;
        const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
        const packet = JSON.parse(row!.packet) as Record<string, unknown>;
        assert.equal("assistant" in packet, false, "terminal capacity failure preserves only the attempted request");
        const errRow = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        const failure = errRow
            .map((row) => JSON.parse(row.rx) as {
                problem?: {
                    type?: string;
                    status?: number;
                    detail?: string;
                    capacityStage?: string;
                    capacity?: {
                        decision?: string;
                        inputCapacity?: number;
                        prompt?: { kind?: string; tokens?: number; source?: string };
                    };
                    retryable?: boolean;
                };
            })
            .findLast((row) => row.problem?.type?.endsWith("/capacity-exceeded") === true)
            ?.problem;
        assert.ok(failure !== undefined);
        assert.equal(failure.status, 413);
        assert.equal(failure.retryable, false);
        assert.equal(failure.capacityStage, "preflight");
        assert.equal(failure.capacity?.decision, "reject");
        assert.equal(failure.capacity?.inputCapacity, TINY);
        assert.equal(failure.capacity?.prompt?.kind, "exact");
        assert.ok((failure.capacity?.prompt?.tokens ?? 0) > TINY);
        assert.equal(failure.capacity?.prompt?.source, "mock:chars2");
        assert.match(failure.detail ?? "", /exceeds its exact input capacity/);
        const calls = await db.test_model_calls.all<{ capacity: string | null }>({ turn_id: turnId });
        assert.ok(calls.length >= 1 && calls.every(({ capacity }) => capacity !== null), "every failed logical request retains its request-shaped capacity evidence");
    } finally { await db.close(); }
});

test("an upstream 413 withholds the automatic prompt body and retries without spending an emission attempt", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prompt-capacity-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(
            db,
            workerId,
            1,
            `${PROMPT_CAPACITY_SENTINEL}\n${"large prompt body\n".repeat(10_000)}`,
        );
        const provider = new UpstreamPromptCapacityMock({
            contextWindow: 100_000,
            responses: [response([sendStmt(200, "recovered")])],
        });
        const result = await plainEngine(db).runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 1,
        });

        assert.equal(result.status, 200);
        assert.equal(result.emissionAttempts, 1, "only the completed response consumes a grammar-emission attempt");
        assert.equal(provider.remaining, 0, "capacity recovery consumes the one queued model response exactly once");
        assert.equal(provider.requests.length, 2, "one rejected physical request is followed by one changed request");
        assert.ok(provider.requests[0]?.some(({ content }) => content.includes(PROMPT_CAPACITY_SENTINEL)));
        assert.ok(provider.requests[1]?.every(({ content }) => !content.includes(PROMPT_CAPACITY_SENTINEL)), "the retry withholds only the automatic prompt body");

        const calls = await db.test_model_calls.all<{ state: string; capacity: string | null }>({ turn_id: result.turnId });
        assert.deepEqual(calls.map(({ state }) => state), ["error", "response"]);
        assert.ok(calls.every(({ capacity }) => capacity !== null), "both logical requests retain request-shaped capacity evidence");
        const attempts = await db.test_turn_attempts.all<{ accepted: number | null }>({ turn_id: result.turnId });
        assert.deepEqual(
            attempts.map(({ accepted }) => accepted),
            [null, 1],
            "the response-less call remains unclassified and only the completed exchange is admitted",
        );
        const requests = await db.test_provider_requests.all<{ outcome: string }>({ turn_id: result.turnId });
        assert.deepEqual(requests.map(({ outcome }) => outcome), ["error", "response"], "both physical requests remain cardinal accounting facts");

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        assert.match(packetSection(packet, "errors"), /^\* 413 log:\/\/\/.+\/error$/m, "the recovered rejection remains visible to the model");
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
        await engine.runTurn({
            provider: mockAt(
                TINY,
                [response([read, sendStmt(200, "done")])],
                200_000,
                true,
            ),
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 2,
        });
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

test("a request outside exact provider input capacity returns 413 before physical generation", async () => {
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

test("an estimate defers physical admission to the upstream provider", async () => {
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
        const result = await engine.runLoop({ provider: mock, workspaceId, workerId, loopId, messages, maxTurns: 5 });
        assert.equal(result.result.status, 200);
        assert.equal(mock.remaining, 2, "an empirical estimate neither admits nor rejects; the upstream mock receives the request");
        assert.deepEqual(
            measuredMessages?.map(({ role }) => role),
            ["system", "user"],
            "the provider measured the same two rendered slots dispatched by PacketWire",
        );
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.equal(errors.length, 0, "deferred admission is not an error");
    } finally {
        await db.close();
    }
});

test("a proven request-token upper bound can authorize provider admission", async () => {
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
        const result = await engine.runLoop({ provider: mock, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.result.status, 200);
        assert.equal(mock.remaining, 0, "the proven bound admits the request to generation");
    } finally {
        await db.close();
    }
});
