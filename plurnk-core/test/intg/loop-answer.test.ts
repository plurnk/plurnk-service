// {§loop-answer} — ops://<worker>/<loop> is what the loop said: the latest reply to the message that
// started it.
import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { statement } from "./reasoning-fixture.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";

test("{§loop-answer}: a loop's address reads its SEND answer; running is 425, absent is 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-answer-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const first = await insertLoop(db, workerId, 1, "What is two plus two?");
        const look = (address: string) => engine.look({ workspaceId, workerId, loopId: first, statement: statement(`\`\`\`\`READ (${address})\`\`\`\``) });

        const running = await look("ops://alice/1");
        assert.equal(running.status, 425, "a loop still running has not answered yet");
        assert.equal(running.problem?.type, "https://problems.plurnk.xyz/scheme/ops/loop-running");

        const firstReply = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "````SEND\nFour.\n````", reasoning: null } }] }),
            workspaceId, workerId, loopId: first, maxTurns: 3, messages: [{ role: "user", content: "What is two plus two?" }],
        });
        assert.equal(firstReply.result.status, 200);
        const answered = await look("ops://alice/1");
        assert.equal(answered.status, 200);
        assert.ok("content" in answered);
        assert.equal(answered.content, "Four.", "the SEND is the loop's answer");
        const row = await look("log:///1/2/2/SEND");
        assert.equal(row.status, 200, "a final reply is an ordinary SEND row");

        const second = await insertLoop(db, workerId, 2, "And three plus three?");
        const sent = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "````SEND\nSix.\n````", reasoning: null } }] }),
            workspaceId, workerId, loopId: second, maxTurns: 3, messages: [{ role: "user", content: "And three plus three?" }],
        });
        assert.equal(sent.result.status, 200);
        const reply = await look("ops://alice/2");
        assert.ok("content" in reply);
        assert.equal(reply.content, "Six.", "a SEND answer is the loop's answer too, without its fence");
        const written = (await db.test_log_entries_by_turn.all<{ op: string; origin: string; attrs: string; tx: string }>({ turn_id: sent.turnIds.at(-1)! }))
            .find(({ op, origin }) => op === "SEND" && origin === "model");
        assert.equal(LogEntryProjection.leaf(written!), "SEND", "a SEND the model wrote stays a SEND");

        assert.equal((await look("ops://alice/9")).status, 404, "a loop that does not exist");
        assert.equal((await look("ops://alice/1/2")).status, 200, "a turn coordinate still reads that turn's emission");
    } finally { await db.close(); }
});

test("{§loop-answer}: a concluded child's termination IS what it said, read at its own address", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-answer-child-${crypto.randomUUID()}`);
        const parentId = await insertWorker(db, workspaceId, null, "lead");
        const childId = await insertWorker(db, workspaceId, parentId, "reviewer");
        const loopId = await insertLoop(db, childId, 1, "Review the draft.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "````SEND\nThe draft is sound.\n````", reasoning: null } }] }),
            workspaceId, workerId: childId, loopId, maxTurns: 3, messages: [{ role: "user", content: "Review the draft." }],
        });
        assert.equal(result.result.status, 200);
        const events = await db.test_loop_termination_events.all<{ rx: string }>({ recipient_worker_id: parentId });
        assert.deepEqual(events.map(({ rx }) => JSON.parse(rx)), [{ status: 200 }], "the event retains the child's exact terminal result");
        const answer = await engine.look({ workspaceId, workerId: parentId, loopId, statement: statement("````READ (ops://reviewer/1)````") });
        assert.ok("content" in answer);
        assert.equal(answer.content, "The draft is sound.", "the parent reads the answer where the termination points");
    } finally { await db.close(); }
});
