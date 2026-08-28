// SPEC {§overflow-turn} — the budget overflow recovery. The model "behaves" here (a clean SEND each
// turn); these tests exercise the engine's enforcement, not the model. An
// absolute ceiling far below any real packet forces overflow deterministically.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { Mock, ProviderError, validateProviderRequestAccounting } from "@plurnk/plurnk-providers";
import type { ChatMessage, MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, insertOperationTurn, packetSection } from "./_helpers.ts";
import { foldStmt, openStmt, planValue, urlPath } from "./_dsl.ts";
import OverflowTurn from "../../src/core/OverflowTurn.ts";

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", annotation: null, delimiter: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null }, position: { line: 1, column: 1 },
});
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([sendStmt(200, "ok")]));

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const TINY = 2;          // absolute wall far below any real packet → forces overflow

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

class ExactCharCapacityMock extends Mock {
    override async countPromptTokens(messages: readonly ChatMessage[]) {
        return {
            kind: "exact" as const,
            tokens: messages.reduce((sum, { content }) => sum + content.length, 0),
            source: "test:exact-chars",
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
const exactCharAt = (capacity: number, responses: MockResponse[], window = 1_000_000): ExactCharCapacityMock => {
    const keys = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const previous = keys.map((key) => process.env[key]);
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(window - capacity);
    delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    const provider = new ExactCharCapacityMock({ contextWindow: window, responses });
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

const applyOverflowPlan = async ({ db, engine, workspaceId, workerId, loopId, turnId }: {
    db: Db;
    engine: Engine;
    workspaceId: number;
    workerId: number;
    loopId: number;
    turnId: number;
}) => {
    const existing = await db.test_log_entries_by_turn.all<{ sequence: number }>({ turn_id: turnId });
    let sequence = Math.max(0, ...existing.map((row) => row.sequence)) + 1;
    const folds = await OverflowTurn.plan(db, loopId, turnId);
    for (const { statement } of folds) {
        const result = await engine.dispatch({
            statement,
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: sequence++,
            origin: "_plurnk",
        });
        assert.ok(result.status < 400, "the deterministic recovery plan dispatches successfully");
    }
    return folds;
};

test("under the ceiling the overflow recovery never fires — nothing is hidden", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const provider = mockAt(4096, okSends(2)); // full-window ceiling — never overflows
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        // Under the ceiling the overflow recovery early-returns before pass 1, so turn 1's
        // log stays shown — it would be hidden only on overflow.
        const log = await db.engine_render_log.all<{ turn_seq: number }>({ worker_id: workerId });
        assert.ok(log.some((r) => r.turn_seq === 2), "no overflow → prior model turn's log still shown, overflow recovery inert");
    } finally { await db.close(); }
});

test("on overflow the prior turn's log entries are folded to their coordinate", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        // Turn 1 runs under a WIDE ceiling so the model completes and leaves
        // open prompt + SEND bodies. Turn 2 runs under TINY, so ordinary
        // recovery folds the complete preceding-turn body set without exemptions.
        const engine = plainEngine(db);
        const wideP = mockAt(4096, okSends(1));
        const tinyP = mockAt(TINY, okSends(2), 4096, true);
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = await db.engine_render_log.all<{ turn_seq: number; folded: string; weight: number }>({ worker_id: workerId });
        assert.ok(before.some((r) => r.turn_seq === 2 && r.weight > 0 && r.folded === "[]"), "the first model turn left an open body");
        await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const after = await db.engine_render_log.all<{ turn_seq: number; folded: string; weight: number }>({ worker_id: workerId });
        const t1 = after.filter((r) => r.turn_seq === 2 && r.weight > 0);
        assert.ok(t1.length > 0 && t1.every((r) => r.folded === "[[1,-1]]"), "every preceding-turn body is folded to its address, including PLAN/prompt/error kinds");
    } finally { await db.close(); }
});

test("a PLAN row at the newest boundary follows the same whole-body overflow fold", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        // Turn 1 emits PLAN + SEND under a WIDE ceiling. Turn 2 under TINY
        // overflows: PLAN is evidence from the same causal turn, not a protected
        // packet surface, so it remains addressable but folds with its peers.
        const planStmt = {
            op: "PLAN", annotation: null, delimiter: "", signal: null, target: null,
            lineMarker: null,
            body: [{
                content: "Read the document, then answer.",
                status: "in_progress",
            }],
            position: { line: 1, column: 1 },
        } as PlurnkStatement;
        const engine = plainEngine(db);
        const wideP = mockAt(4096, [response([planStmt, sendStmt(200, "ok")])]);
        const tinyP = mockAt(TINY, okSends(1), 4096, true);
        await engine.runTurn({ provider: wideP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = await db.engine_render_log.all<{ turn_seq: number; op: string; folded: string }>({ worker_id: workerId });
        assert.ok(before.some((r) => r.turn_seq === 2 && r.op === "PLAN" && r.folded === "[]"), "the first model turn's PLAN landed open");
        await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const after = await db.engine_render_log.all<{ turn_seq: number; op: string; folded: string; pathname: string | null; weight: number }>({ worker_id: workerId });
        const plan = after.find((r) => r.turn_seq === 2 && r.op === "PLAN");
        assert.equal(plan?.folded, "[[1,-1]]", "the PLAN body is forensically retained and genuinely folded");
        const folded = after.filter((r) => r.turn_seq === 2 && r.weight > 0);
        assert.ok(folded.length > 0 && folded.every((r) => r.folded === "[[1,-1]]"), "the complete causal turn folds under one rule");
    } finally { await db.close(); }
});

test("the overflow recovery never folds older history - the model owns its visibility", async () => {
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
        const openT1before = (await db.engine_render_log.all<{ turn_seq: number; folded: string; weight: number }>({ worker_id: workerId }))
            .filter((r) => r.turn_seq === 2 && r.weight > 0 && r.folded === "[]").length;
        assert.ok(openT1before > 0, "precondition: turn 1 left older open rows");
        await engine.runTurn({ provider: tinyP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 3 });
        const after = await db.engine_render_log.all<{ turn_seq: number; folded: string; weight: number }>({ worker_id: workerId });
        assert.equal(after.filter((r) => r.turn_seq === 2 && r.weight > 0 && r.folded === "[]").length, openT1before,
            "turn 1's open rows are untouched by the turn-3 overflow recovery fire");
        assert.ok(after.filter((r) => r.turn_seq === 3 && r.weight > 0).every((r) => r.folded === "[[1,-1]]"),
            "the newest completed model turn IS folded — the boundary rule fired");
    } finally { await db.close(); }
});

test("{§overflow-turn-curation}: the causal predecessor is producer-neutral and crosses loop boundaries", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const predecessorId = await insertOperationTurn(db, loopId, 1, "plugin");
        const predecessor = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: predecessorId, sequence: 1,
            origin: "plugin", source: null, model_call_id: null, op: "READ", delimiter: "", signal: null,
            scheme: "worker", username: null, password: null, hostname: null, port: null,
            pathname: "/plugin-result", query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 200, content: "plugin result", mimetype: "text/plain", startLine: 1 }),
            mimetype_rx: "application/json", status_rx: 200, weight: 7,
            state: "resolved", outcome: null, attrs: "{}",
        });
        if (predecessor === undefined) throw new Error("plugin predecessor fixture insert returned no row");

        const nextLoopId = await insertLoop(db, workerId, 2, "continue");
        const currentTurnId = await insertTurn(db, nextLoopId, 1, 102);
        const engine = plainEngine(db);
        const recovery = await applyOverflowPlan({
            db,
            engine,
            workspaceId,
            workerId,
            loopId: nextLoopId,
            turnId: currentTurnId,
        });

        assert.ok(recovery.some(({ statement }) => statement.target?.raw === "log:///1/1/1/READ"), "the immediately preceding plugin turn is selected across the loop boundary");
        const row = (await db.engine_render_log.all<{ id: number; folded: string }>({ worker_id: workerId }))
            .find(({ id }) => id === predecessor.id);
        assert.equal(row?.folded, "[[1,-1]]", "producer identity does not change causal ownership");
    } finally { await db.close(); }
});

test("{§overflow-turn-curation}: overflow whole-folds older bodies whose visibility the completed turn increased", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const oldTurnId = await insertTurn(db, loopId, 1, 200);
        const seed = async (sequence: number, op: "READ" | "EDIT" | "PLAN", content: string): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: oldTurnId, sequence,
                origin: "model", source: null, model_call_id: null, op, delimiter: "", signal: null,
                scheme: "worker", username: null, password: null, hostname: null, port: null,
                pathname: `/old-${sequence}`, query: null, fragment: null, lineMarker: null,
                tx: JSON.stringify(op === "PLAN" ? { body: planValue(content) } : { op }), mimetype_tx: "application/json",
                rx: JSON.stringify(op === "PLAN" ? { status: 200 } : { status: 200, content, mimetype: "text/plain", startLine: 1 }),
                mimetype_rx: "application/json", status_rx: 200, weight: 0,
                state: "resolved", outcome: null, attrs: "{}",
            });
            if (row === undefined) throw new Error("old log fixture insert returned no row");
            return row.id;
        };
        const newlyOpenedId = await seed(1, "READ", "R".repeat(8_000));
        const alreadyOpenId = await seed(2, "READ", "small no-op OPEN target");
        const unrelatedId = await seed(3, "EDIT", "unrelated older history");
        const openedPlanId = await seed(4, "PLAN", "persisted orientation");
        await db.engine_fold_log_entry.run({ id: newlyOpenedId });
        await db.engine_fold_log_entry.run({ id: openedPlanId });

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
            folded_before: string;
            op: string;
            turn_id: number;
        }>({ worker_id: workerId });
        assert.deepEqual(
            effects.map(({ target_log_entry_id, folded_before, op, turn_id }) => ({ target_log_entry_id, folded_before, op, turn_id })),
            [
                { target_log_entry_id: newlyOpenedId, folded_before: "[[1,-1]]", op: "OPEN", turn_id: curationTurnId },
                { target_log_entry_id: alreadyOpenId, folded_before: "[]", op: "OPEN", turn_id: curationTurnId },
                { target_log_entry_id: openedPlanId, folded_before: "[[1,-1]]", op: "OPEN", turn_id: curationTurnId },
            ],
            "the suppressed event retains its exact selected set and each target's prior visibility",
        );

        const currentTurnId = await insertTurn(db, curationLoopId, 2, 102);
        const recovery = await applyOverflowPlan({
            db,
            engine: plainEngine(db),
            workspaceId,
            workerId,
            loopId: curationLoopId,
            turnId: currentTurnId,
        });
        assert.ok(recovery.length > 0, "the exact prior OPEN effect produces an ordinary FOLD statement");
        const rows = await db.engine_render_log.all<{ id: number; folded: string; tags: string }>({ worker_id: workerId });
        const byId = new Map(rows.map((row) => [row.id, row]));
        assert.equal(byId.get(newlyOpenedId)?.folded, "[[1,-1]]", "the folded-to-open target is whole-folded");
        assert.deepEqual(JSON.parse(byId.get(newlyOpenedId)?.tags ?? "[]"), ["_plurnk", "overflow"], "the causal fold records its actor and reason");
        assert.equal(byId.get(alreadyOpenId)?.folded, "[]", "a no-op OPEN does not make older context overflow recovery-owned");
        assert.deepEqual(JSON.parse(byId.get(alreadyOpenId)?.tags ?? "[]"), [], "the no-op target receives no overflow provenance");
        assert.equal(byId.get(unrelatedId)?.folded, "[]", "unselected older history remains model-owned");
        assert.equal(byId.get(openedPlanId)?.folded, "[[1,-1]]", "an older PLAN exposed by the causal turn is folded like every other body");
        assert.deepEqual(JSON.parse(byId.get(openedPlanId)?.tags ?? "[]"), ["_plurnk", "overflow"], "the PLAN receives ordinary recovery provenance");
    } finally { await db.close(); }
});

test("{§overflow-turn-curation}: a reopened target folded again before recovery is not attributed to overflow", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const oldTurnId = await insertTurn(db, loopId, 1, 200);
        const target = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: oldTurnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "READ", delimiter: "", signal: null,
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
        await applyOverflowPlan({ db, engine, workspaceId, workerId, loopId, turnId: currentTurnId });
        const row = (await db.engine_render_log.all<{ id: number; folded: string; tags: string }>({ worker_id: workerId }))
            .find(({ id }) => id === target.id);
        assert.equal(row?.folded, "[[1,-1]]", "the model's later FOLD remains authoritative");
        assert.deepEqual(JSON.parse(row?.tags ?? "[]"), [], "the overflow recovery does not claim a row that was already folded");
        const effects = await db.test_log_curation_effects_by_worker.all<{ op: string; folded_before: string }>({ worker_id: workerId });
        assert.deepEqual(effects.map(({ op, folded_before }) => ({ op, folded_before })), [
            { op: "OPEN", folded_before: "[[1,-1]]" },
            { op: "FOLD", folded_before: "[]" },
        ], "both curation events retain their exact prior state");
    } finally { await db.close(); }
});

test("{§overflow-turn-curation}: a causal OPEN makes the complete older body recovery-owned", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const oldTurnId = await insertTurn(db, loopId, 1, 200);
        const content = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
        const target = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: oldTurnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "READ", delimiter: "", signal: null,
            scheme: "worker", username: null, password: null, hostname: null, port: null,
            pathname: "/old", query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 200, content, mimetype: "text/plain", startLine: 1 }),
            mimetype_rx: "application/json", status_rx: 200, weight: content.length,
            state: "resolved", outcome: null, attrs: "{}",
        });
        if (target === undefined) throw new Error("old log fixture insert returned no row");
        await db.log_set_folded_by_id.run({ id: target.id, folded: "[[3,5]]" });

        const curationTurnId = await insertTurn(db, loopId, 2, 200);
        const engine = plainEngine(db);
        await engine.dispatch({
            statement: { ...openStmt(urlPath("log", "/1/1/1/READ")), lineMarker: { marks: [3, 5] } },
            workspaceId, workerId, loopId, turnId: curationTurnId, sequence: 1, origin: "model",
        });
        await engine.dispatch({
            statement: { ...foldStmt(urlPath("log", "/1/1/1/READ")), lineMarker: { marks: [8] } },
            workspaceId, workerId, loopId, turnId: curationTurnId, sequence: 2, origin: "model",
        });

        const currentTurnId = await insertTurn(db, loopId, 3, 102);
        await applyOverflowPlan({ db, engine, workspaceId, workerId, loopId, turnId: currentTurnId });

        const row = (await db.engine_render_log.all<{ id: number; folded: string; tags: string }>({ worker_id: workerId }))
            .find(({ id }) => id === target.id);
        assert.deepEqual(JSON.parse(row?.folded ?? "null"), [[1, -1]], "recovery folds the body whole instead of reconstructing interval arithmetic");
        assert.deepEqual(JSON.parse(row?.tags ?? "[]"), ["_plurnk", "overflow"]);
        for (const sequence of [1, 2]) {
            const curation = await db.test_get_log_folded.get<{ folded: string }>({
                worker_id: workerId,
                loop_seq: 1,
                turn_seq: 2,
                sequence,
            });
            assert.equal(curation?.folded, "[]", "a bodyless boundary row has no visibility to roll back");
        }
    } finally { await db.close(); }
});

test("an unrecoverable curation floor fails at 413 without provider I/O", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const provider = mockAt(TINY, okSends(1), 200_000, true);
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.result.status, 413);
        assert.equal(result.reason, "token_budget");
        assert.equal(provider.remaining, 1, "the over-ceiling request never reaches generation");
        assert.equal(result.turnIds.length, 2, "initialization and recovery are real packetless turns");
        for (const turnId of result.turnIds) {
            const row = await db.test_get_packet.get<{ packet: string | null }>({ id: turnId });
            assert.equal(row?.packet, null, "neither packetless turn impersonates a model request");
        }
        const recoveryTurnId = result.turnIds.at(-1)!;
        const recovery = await db.test_get_turn.get<{ producer: string; kind: string }>({ id: recoveryTurnId });
        assert.deepEqual(
            { producer: recovery?.producer, kind: recovery?.kind },
            { producer: "_plurnk", kind: "overflow" },
        );
        const rows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            origin: string;
            tx: string;
            rx: string;
            attrs: string;
            folded: string;
        }>({ turn_id: recoveryTurnId });
        const plan = rows.find(({ op }) => op === "PLAN");
        assert.equal(plan?.origin, "_plurnk");
        assert.deepEqual(
            (JSON.parse(plan!.tx) as { body: unknown }).body,
            planValue("Automatically FOLD log bodies newly active at token-budget overflow."),
        );
        const turnOps = rows.find(({ op }) => op === null);
        assert.equal(turnOps?.origin, "_plurnk");
        assert.equal(JSON.parse(turnOps?.attrs ?? "null").kind, "turnOps");
        assert.equal(turnOps?.folded, "[[1,-1]]", "overflow turnOps are ordinary folded source evidence");
        const source = JSON.parse(turnOps?.rx ?? "null").content as string;
        assert.match(source, /^# PLAN0\n\[\{"content":"Automatically FOLD log bodies newly active at token-budget overflow\.","status":"in_progress"}\]\n/);
        assert.match(source, /\n## SEND0 \[102\]\nNext: YOU MUST ONLY FOLD, KILL, or trim ALL superseded, stale, or irrelevant log content in bulk\.$/);
    } finally { await db.close(); }
});

test("{§overflow-turn-curation}: a current-turn engine row receives an exact whole-body FOLD", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        // Turn 1 — small, real (leaves a tiny open log).
        const engine = plainEngine(db);
        await engine.runTurn({ provider: mockAt(4096, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        // The next turn is opened manually; a huge OPEN engine-origin row lands on it pre-model.
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        if (next === undefined) throw new Error("next turn sequence unavailable");
        const turnId = await insertTurn(db, loopId, next.next, 102);
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "_plurnk", source: null, model_call_id: null, op: "READ", delimiter: "", signal: null,
            scheme: "search", username: null, password: null, hostname: null, port: null,
            pathname: "/1/1/7", query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 200, content: Array.from({ length: 40 }, (_, index) => `line ${index + 1}: ${"R".repeat(80)}`).join("\n") }), mimetype_rx: "application/json",
            status_rx: 200, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 2,
            origin: "_plurnk", source: "rail", model_call_id: null, op: "error", delimiter: "", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ message: "causal error evidence" }), mimetype_rx: "application/json",
            status_rx: 400, weight: 11, state: "resolved", outcome: null, attrs: "{}",
        });
        const recovery = await applyOverflowPlan({ db, engine, workspaceId, workerId, loopId, turnId });
        const currentFold = recovery.find(({ statement }) => statement.target?.raw === `log:///1/${next.next}/1/READ`);
        const errorFold = recovery.find(({ statement }) => statement.target?.raw === `log:///1/${next.next}/2/error`);
        assert.ok(currentFold !== undefined, "the current boundary row receives its own exact FOLD");
        assert.ok(errorFold !== undefined, "an error body follows the same causal rule without exemption");
        assert.deepEqual(currentFold.statement.lineMarker?.marks, [1, -1]);
        const rows = await db.engine_render_log.all<{ turn_seq: number; op: string; folded: string; tags: string }>({ worker_id: workerId });
        const bigRow = rows.find((r) => r.turn_seq === next.next && r.op === "READ");
        assert.ok(bigRow !== undefined, "the wake row is still LISTED (folded, not deleted)");
        assert.equal(bigRow.folded, "[[1,-1]]", "the active preview is explicitly folded so recovery reclaims packet weight");
        assert.deepEqual(JSON.parse(bigRow.tags), ["_plurnk", "overflow"], "the automatic fold stamps actor and reason tags");
        const errorRow = rows.find((r) => r.turn_seq === next.next && r.op === "error");
        assert.equal(errorRow?.folded, "[[1,-1]]", "the causal error remains addressable but wholly folded");
    } finally { await db.close(); }
});

test("the curation ceiling reuses provider-derived input capacity without a calibration ratio", async () => {
    const db = await openMigrated();
    try {
        const b = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        // {§tokenomics-window-partition} — the provider's resolved input
        // capacity is 9998 under this request envelope.
        // No ratio: the model-facing measure is the chars/2 ruler, and comparing ruler-weight to
        // this real-token ceiling is the conservative bias ({§tokenomics-agnostic-ruler}).
        const provider = mockAt(9998, [], 10_000);
        assert.equal(b.curationBudgetFor(provider), 9998, "curation reuses the provider's derived input capacity verbatim");
    } finally { await db.close(); }
});

test("an exact provider overflow remains distinct from curation admission", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        await engine.runTurn({
            provider: mockAt(999_000, [response([sendStmt(102, "continue")])], 1_000_000),
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 1,
        });
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        if (next === undefined) throw new Error("next turn sequence unavailable");
        const probeProvider = mockAt(999_000, [], 1_000_000);
        const probe = await new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined }).buildRequestPacket({
            initialMessages: MESSAGES,
            workspaceId,
            workerId,
            loopId,
            currentTurnSeq: next.next,
            provider: probeProvider,
            gitStatus: null,
        });
        const exactChars = PacketWire.packetToWireMessages(probe)
            .reduce((sum, { content }) => sum + content.length, 0);
        const capacity = Math.floor((probe.weight + exactChars) / 2);
        assert.ok(probe.weight < capacity && capacity < exactChars, "fixture separates the curation ruler from provider tokens");

        const provider = exactCharAt(capacity, [response([sendStmt(200, "unreachable")])]);
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(result.status, 413);
        assert.equal(result.capacityHardStop, true);
        assert.equal(provider.remaining, 1, "exact preflight rejection consumes no generated response");
        const turnId = result.turnId;
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
        assert.equal(failure.capacity?.inputCapacity, capacity);
        assert.equal(failure.capacity?.prompt?.kind, "exact");
        assert.ok((failure.capacity?.prompt?.tokens ?? 0) > capacity);
        assert.equal(failure.capacity?.prompt?.source, "test:exact-chars");
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
