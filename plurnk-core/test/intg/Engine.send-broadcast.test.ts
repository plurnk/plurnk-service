import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";
import { noteStmt, sendStmt, urlPath } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, env, engine, lifecycle: new LoopLifecycle(db) };
};

for (const statement of [sendStmt(null, "An answer."), noteStmt("A determination.")]) {
    test(`{§turn-disposition} dispatching ${statement.op} alone does not settle the enclosing program`, async () => {
        const { db, env, engine, lifecycle } = await setup();
        try {
            const result = await engine.dispatch({ ...env, statement, sequence: 1, origin: "model" });
            assert.equal(result.status, 200);
            assert.equal(await lifecycle.status(env.loopId), 102);
            const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number }>({ turn_id: env.turnId });
            assert.equal(log?.status_rx, 200);
        } finally { await db.close(); }
    });
}

test("{§send-response-receipt} a failed endpoint SEND neither answers a message nor concludes", async () => {
    const { db, env, engine, lifecycle } = await setup();
    try {
        const before = await db.message_unanswered_count.get<{ count: number }>({ loop_id: env.loopId });
        const result = await engine.dispatch({ ...env, statement: sendStmt(urlPath("wss", "feed/x"), "message"), sequence: 1, origin: "model" });
        assert.equal(result.status, 501);
        assert.equal(await lifecycle.status(env.loopId), 102);
        assert.deepEqual(await db.message_unanswered_count.get({ loop_id: env.loopId }), before);
    } finally { await db.close(); }
});

test("{§loop-response-messages} every SEND in a program executes before automatic conclusion", async () => {
    const { db, env, engine, lifecycle } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: {
            content: "", reasoning: null, ops: [sendStmt(null, "First."), sendStmt(null, "Second."), noteStmt("Both delivered.")],
        } }] });
        const turn = await engine.runTurn({ ...env, provider, messages: [] });
        assert.equal(turn.status, 200);
        assert.deepEqual(turn.outcomes.map(({ op, status }) => [op, status]), [["SEND", 200], ["SEND", 200], ["NOTE", 200]]);
        assert.equal((await lifecycle.result(env.loopId))?.content, "Second.");
    } finally { await db.close(); }
});

test("{§loop-terminals} a later cancellation cannot overwrite a successful conclusion", async () => {
    const { db, env, engine, lifecycle } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: {
            content: "", reasoning: null, ops: [sendStmt(null, "Answer.")],
        } }] });
        assert.equal((await engine.runTurn({ ...env, provider, messages: [] })).status, 200);
        await lifecycle.cancelTree(env.workerId, "Late cancellation.", true);
        assert.equal(await lifecycle.status(env.loopId), 200);
        assert.equal((await lifecycle.result(env.loopId))?.content, "Answer.");
    } finally { await db.close(); }
});
