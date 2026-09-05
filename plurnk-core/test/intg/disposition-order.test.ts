import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const response = (content: string) => ({ assistant: { content, reasoning: null } });

// {§op-mode-phases} {§emission-admission}
test("trailing log KILLs settle before TERM and preserve exact source rather than becoming answer text", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "disposition-order");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const seed = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response("## PLAN0\n[]\n### EDIT0 (worker:///note.md)\nEvidence.\n### SEND0 (NEXT)\nReview.")] }),
            workspaceId, workerId, loopId, messages: [],
        });
        const originalRows = await db.test_log_entries_by_turn.all<{ id: number; sequence: number; op: string; active: number }>({ turn_id: seed.turnId });
        const plan = originalRows.find(({ op }) => op === "PLAN");
        assert.ok(plan);
        const turn = await db.test_latest_model_turn_in_loop.get<{ sequence: number }>({ loop_id: loopId });
        assert.ok(turn);
        const source = `## PLAN0\n[]\n### SEND0 (TERM)\nAnswer.\n### KILL0 (log:///1/${turn.sequence}/${plan.sequence}/PLAN)`;
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }),
            workspaceId, workerId, loopId, messages: [],
        });
        assert.equal(result.status, 200);
        assert.deepEqual(result.outcomes.map(({ op }) => op), ["PLAN", "KILL", "SEND"]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string; attrs: string }>({ turn_id: result.turnId });
        const send = rows.find(({ op }) => op === "SEND");
        assert.ok(send);
        assert.equal(JSON.parse(send.tx).body.raw, "Answer.");
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(packet);
        assert.equal(JSON.parse(packet.packet).assistant.content, source);
        const retained = await db.test_log_entries_by_turn.all<{ id: number; active: number }>({ turn_id: seed.turnId });
        assert.equal(retained.find(({ id }) => id === plan.id)?.active, 0);
    } finally { await db.close(); }
});

test("NEXT authored first still waits for mutation and observation, including a bounded trailing error", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "next-order");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const source = "### SEND0 (NEXT)\nInspect results.\n### READ0 (worker:///note.md)\n### EDIT0 (worker:///note.md)\nCreated before READ.\n### FIND0 (worker:///*)\n/[/\n### KILL0 (log:///99/*/*)";
        const result = await engine.runTurn({ provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }), workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.status, 102);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => op !== null && op !== "prompt").map(({ op }) => op), ["EDIT", "KILL", "READ", "error", "SEND"]);
        const read = rows.find(({ op }) => op === "READ");
        assert.ok(read);
        assert.equal(JSON.parse(read.rx).content, "Created before READ.");
        assert.equal(rows.filter(({ op, status_rx }) => op === "error" && status_rx === 400).length, 1);
    } finally { await db.close(); }
});

test("duplicate dispositions and unclosed trailing targets dispatch no part of the rejected attempt", async () => {
    for (const tail of ["### SEND0 (TERM)\nContradiction.", "### READ0 (unfinished"]) {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, "rejected-disposition");
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1);
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const result = await engine.runTurn({
                provider: new Mock({ contextWindow: 100_000, responses: [
                    response(`### EDIT0 (worker:///must-not-exist)\nNo effect.\n### SEND0 (NEXT)\nContinue.\n${tail}`),
                    response("### SEND0 (TERM)\nRecovered."),
                ] }), workspaceId, workerId, loopId, messages: [],
            });
            assert.equal(result.status, 200);
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null }>({ turn_id: result.turnId });
            assert.equal(rows.some(({ op }) => op === "EDIT"), false);
            const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: result.turnId });
            assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 1]);
        } finally { await db.close(); }
    }
});

test("internal turn programs use the same disposition source-order contract", () => {
    const source = "## PLAN0\n[]\n### SEND0 (NEXT)\nContinue.\n### KILL0 (log:///1/1/*)";
    const statements = TurnOps.parseInternal(source);
    assert.deepEqual(statements.map(({ op }) => op), ["PLAN", "SEND", "KILL"]);
    assert.equal(TurnOps.renderInternal(statements), source);
});
