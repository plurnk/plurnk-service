import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const response = (content: string) => ({ assistant: { content, reasoning: null } });

// {§disposition-anywhere} {§emission-admission}
test("a KILL after SEND executes: curation and the reply persist before a later conclusion", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "disposition-order");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const seed = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response("````EDIT (worker:///note.md)\nEvidence.\n````\n````NOTE\nReview.\n````")] }),
            workspaceId, workerId, loopId, messages: [],
        });
        const originalRows = await db.test_log_entries_by_turn.all<{ id: number; sequence: number; op: string; active: number }>({ turn_id: seed.turnId });
        const plan = originalRows.find(({ op }) => op === "NOTE");
        assert.ok(plan);
        const turn = await db.test_latest_model_turn_in_loop.get<{ sequence: number }>({ loop_id: loopId });
        assert.ok(turn);
        const source = `\`\`\`\`SEND
Answer.
\`\`\`\`
\`\`\`\`KILL (log:///1/${turn.sequence}/${plan.sequence}/NOTE)\`\`\`\``;
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }),
            workspaceId, workerId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "a SEND with a sibling operation is not terminal");
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["SEND", 200], ["KILL", 200]]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => op !== null && op !== "prompt").map(({ op }) => op), ["SEND", "KILL"]);
        const send = rows.find(({ op }) => op === "SEND");
        assert.ok(send);
        assert.equal(JSON.parse(send.tx).body.raw, "Answer.");
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(packet);
        assert.equal(JSON.parse(packet.packet).assistant.content, source);
        const curated = await db.test_log_entries_by_turn.all<{ id: number; active: number }>({ turn_id: seed.turnId });
        assert.equal(curated.find(({ id }) => id === plan.id)?.active, 0, "the KILL authored after SEND curated the earlier note");
        assert.equal((await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response("````KILL\n````")] }),
            workspaceId, workerId, loopId, messages: [],
        })).status, 200);
    } finally { await db.close(); }
});

test("SEND authored first: later operations run in authored order and completion waits for their results", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "next-order");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const source = "````SEND\nInspect results.\n````\n````EDIT (worker:///note.md)\nCreated before READ.\n````\n````READ (worker:///note.md)````\n````FIND (worker:///*) [{\"pattern\":\"/[/\"}]````";
        const result = await engine.runTurn({ provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }), workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["SEND", 200], ["EDIT", 201], ["READ", 200], [null, 400]],
            "the reply, mutations, retrieval, and bounded diagnostic retain authored order");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: result.turnId });
        const read = rows.find(({ op }) => op === "READ");
        assert.ok(read);
        assert.match(JSON.parse(read.rx).content ?? JSON.stringify(JSON.parse(read.rx)), /Created before READ/u, "the READ observed the EDIT that preceded it");
    } finally { await db.close(); }
});

test("{§unparsed-tail-boundary} a lost boundary refuses only what follows it: the statements before it run, the loss is a row", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "admit-before-loss");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [
                response("````EDIT (worker:///before-loss.md)\nKept.\n````\n````WAIT\nContinue.\n````\n````READ (unfinished"),
            ] }), workspaceId, workerId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "the failed row keeps the loop going; nothing was resampled");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors)]), [[1, [{
            message: "target slot of `READ` opened at line 7 but never closed - add `)`", line: 7, column: 0, source: "grammar",
        }]]], "the one attempt is admitted and carries the tail as its diagnostic");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.some(({ op }) => op === "EDIT"), true, "the statement that closed before the loss ran");
        const loss = rows.find(({ op }) => op === "error");
        assert.ok(loss, "the loss is a failed row of the same turn");
        const problem = JSON.parse(loss.rx).problem;
        assert.equal(problem.detail, "target slot of `READ` opened at line 7 but never closed - add `)`");
        assert.equal(problem.siblingsRetained, true);
    } finally { await db.close(); }
});

test("internal turn programs admit a disposition anywhere like model turns", () => {
    const source = "````KILL (log:///1/1/*)\n````\n\n````WAIT\nContinue.\n````";
    const statements = TurnOps.parseInternal(source);
    assert.deepEqual(statements.map(({ op }) => op), ["KILL", "WAIT"]);
    assert.equal(TurnOps.renderInternal(statements), source);
    // {§disposition-anywhere} — a program that authors an operation after its disposition is valid turnOps.
    const first = TurnOps.parseInternal("````WAIT\nContinue.\n````\n````KILL (log:///1/1/*)````");
    assert.deepEqual(first.map(({ op }) => op), ["WAIT", "KILL"]);
});
