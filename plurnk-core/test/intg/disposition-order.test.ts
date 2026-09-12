import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const response = (content: string) => ({ assistant: { content, reasoning: null } });

// {§disposition-anywhere} {§emission-admission}
test("a KILL after TASK executes before the disposition: the curation lands and completion proceeds", async () => {
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
        assert.equal(result.status, 200, "nothing was dropped, nothing failed unseen, so the completion stands");
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["SEND", 200], ["KILL", 200], ["TASK", 200]]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => op !== null && op !== "prompt").map(({ op }) => op), ["SEND", "KILL", "TASK"]);
        const send = rows.find(({ op }) => op === "SEND");
        assert.ok(send);
        assert.equal(JSON.parse(send.tx).body.raw, "Answer.");
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(packet);
        assert.equal(JSON.parse(packet.packet).assistant.content, source);
        const curated = await db.test_log_entries_by_turn.all<{ id: number; active: number }>({ turn_id: seed.turnId });
        assert.equal(curated.find(({ id }) => id === plan.id)?.active, 0, "the KILL authored after TASK curated the earlier inventory");
    } finally { await db.close(); }
});

test("TASK authored first: every later operation runs in authored order and the disposition settles last", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "next-order");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const source = "```TASK\n[{\"content\":\"Inspect results.\",\"status\":\"in_progress\"}]\n```\n```EDIT (worker:///note.md)\nCreated before READ.\n```\n```READ (worker:///note.md)```\n```FIND (worker:///*) [{\"pattern\":\"/[/\"}]```";
        const result = await engine.runTurn({ provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }), workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["EDIT", 201], ["READ", 200], [null, 400], ["TASK", 102]],
            "EDIT then READ in authored order, the malformed FIND as its bounded diagnostic, the disposition last");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: result.turnId });
        const read = rows.find(({ op }) => op === "READ");
        assert.ok(read);
        assert.match(JSON.parse(read.rx).content ?? JSON.stringify(JSON.parse(read.rx)), /Created before READ/u, "the READ observed the EDIT that preceded it");
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

test("internal turn programs admit a disposition anywhere like model turns", () => {
    const source = "````KILL (log:///1/1/*)\n````\n\n````TASK\n[{\"content\":\"Continue.\",\"status\":\"in_progress\"}]\n````";
    const statements = TurnOps.parseInternal(source);
    assert.deepEqual(statements.map(({ op }) => op), ["KILL", "TASK"]);
    assert.equal(TurnOps.renderInternal(statements), source);
    // {§disposition-anywhere} — a program that authors an operation after its disposition is valid turnOps.
    const first = TurnOps.parseInternal("```TASK\n[{\"content\":\"Continue.\",\"status\":\"in_progress\"}]\n```\n```KILL (log:///1/1/*)```");
    assert.deepEqual(first.map(({ op }) => op), ["TASK", "KILL"]);
});
