import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const response = (content: string) => ({ assistant: { content, reasoning: null } });

// {§disposition-ends-turn} {§emission-admission}
test("a KILL after TASK never executes: one diagnostic, completion refused, preceding SEND retained", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "disposition-order");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const seed = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response("```EDIT (worker:///note.md)\nEvidence.\n```\n```TASK\n[{\"content\":\"Review.\",\"status\":\"in_progress\"}]\n```")] }),
            workspaceId, workerId, loopId, messages: [],
        });
        const originalRows = await db.test_log_entries_by_turn.all<{ id: number; sequence: number; op: string; active: number }>({ turn_id: seed.turnId });
        const plan = originalRows.find(({ op }) => op === "TASK");
        assert.ok(plan);
        const turn = await db.test_latest_model_turn_in_loop.get<{ sequence: number }>({ loop_id: loopId });
        assert.ok(turn);
        const source = `\`\`\`SEND
Answer.
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\`
\`\`\`KILL (log:///1/${turn.sequence}/${plan.sequence}/TASK)\`\`\``;
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }),
            workspaceId, workerId, loopId, messages: [],
        });
        // The dropped KILL is a same-turn failure the model has not seen, so the TERM is refused and the loop continues.
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes, [
            { op: "SEND", status: 200, problemType: null },
            { op: null, status: 400, problemType: "https://problems.plurnk.xyz/grammar/parser/invalid-operation-syntax" },
            { op: "TASK", status: 409, problemType: "https://problems.plurnk.xyz/engine/dispatcher/unobserved-failures" },
        ]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string; rx: string; attrs: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => op !== null && op !== "prompt").map(({ op }) => op), ["SEND", "error", "TASK"]);
        const diagnostic = rows.find(({ op }) => op === "error");
        assert.ok(diagnostic);
        assert.equal(
            JSON.parse(diagnostic.rx).problem.detail,
            `\`TASK\` ended the turn; 1 operation after its body was not admitted (KILL ×1). Other operations precede TASK.`,
        );
        const send = rows.find(({ op }) => op === "SEND");
        assert.ok(send);
        assert.equal(JSON.parse(send.tx).body.raw, "Answer.");
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(packet);
        assert.equal(JSON.parse(packet.packet).assistant.content, source);
        const retained = await db.test_log_entries_by_turn.all<{ id: number; active: number }>({ turn_id: seed.turnId });
        assert.equal(retained.find(({ id }) => id === plan.id)?.active, 1, "the KILL after the disposition never ran");
    } finally { await db.close(); }
});

test("TASK authored first ends the turn: nothing after it executes, and one diagnostic counts what was dropped", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "next-order");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const source = "```TASK\n[{\"content\":\"Inspect results.\",\"status\":\"in_progress\"}]\n```\n```READ (worker:///note.md)```\n```EDIT (worker:///note.md)\nCreated before READ.\n```\n```FIND (worker:///*)\n/[/\n```\n```KILL (log:///99/*/*)```";
        const result = await engine.runTurn({ provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }), workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.status, 102);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => op !== null && op !== "prompt").map(({ op }) => op), ["error", "TASK"]);
        const diagnostic = rows.find(({ op }) => op === "error");
        assert.ok(diagnostic);
        assert.equal(diagnostic.status_rx, 400);
        assert.equal(
            JSON.parse(diagnostic.rx).problem.detail,
            `\`TASK\` ended the turn; 3 operations after its body were not admitted (READ ×1, EDIT ×1, KILL ×1) and 1 malformed heading after it was ignored. Other operations precede TASK.`,
        );
        assert.equal(rows.some(({ op }) => op === "EDIT" || op === "READ" || op === "KILL"), false, "nothing after the disposition ran");
    } finally { await db.close(); }
});

test("duplicate dispositions and unclosed trailing targets dispatch no part of the rejected attempt", async () => {
    for (const tail of ["```SEND\nContradiction.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", "```READ (unfinished"]) {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, "rejected-disposition");
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1);
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const result = await engine.runTurn({
                provider: new Mock({ contextWindow: 100_000, responses: [
                    response(`\`\`\`EDIT (worker:///must-not-exist)
No effect.
\`\`\`
\`\`\`TASK
[{"content":"Continue.","status":"in_progress"}]
\`\`\`
${tail}`),
                    response("```SEND\nRecovered.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
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

test("internal turn programs end at the disposition like model turns", () => {
    const source = "```KILL (log:///1/1/*)```\n```TASK\n[{\"content\":\"Continue.\",\"status\":\"in_progress\"}]\n```";
    const statements = TurnOps.parseInternal(source);
    assert.deepEqual(statements.map(({ op }) => op), ["KILL", "TASK"]);
    assert.equal(TurnOps.renderInternal(statements), source);
    // {§disposition-ends-turn} — a program that authors an operation after its disposition is invalid turnOps.
    assert.throws(
        () => TurnOps.parseInternal("```TASK\n[{\"content\":\"Continue.\",\"status\":\"in_progress\"}]\n```\n```KILL (log:///1/1/*)```"),
        { name: "SyntaxError", message: /Core generated invalid turnOps: `TASK` ended the turn; 1 operation after its body was not admitted \(KILL ×1\)/u },
    );
});
