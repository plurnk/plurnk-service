import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import TerminalResult from "../../src/core/TerminalResult.ts";
import { lastReply } from "./_packet.ts";
import { holdChild, insertLoop, insertSession, insertWorkspace, openMigrated, sendingOperation } from "./_db.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelSession } from "./_sessions.ts";

const response = (content: string) => ({
    assistant: { content, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
const collect = "````READ (session://child)````\n````WAIT\nCollect the child result.\n````";
// A contract violation that strikes: a third COPY operand ({§extra-path-slot}); a fumbled matcher
// would not ({§matcher-refusal}).
const extraSlotCopy = "````COPY (workspace:///a) (workspace:///b) (workspace:///c)````";

for (const priorStrike of [false, true]) {
    test(`{§join-blocking-collect} a complete-loop collect parks without a strike${priorStrike ? " after prior failure" : " at maxStrikes=1"}`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "join-rails");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Collect the child answer.");
        const childId = await insertSession(db, workspaceId, sessionId, "child");
        const childLoop = await insertLoop(db, childId, 1, "Compute the answer.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            ...(priorStrike ? [response(`${extraSlotCopy}
\`\`\`\`WAIT
Await results.
\`\`\`\``)] : []),
            response(collect),
            response(collect),
            response(collect),
            response("````SEND [200]\n42\n````"),
        ] });
        const run = () => new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 8, maxStrikes: priorStrike ? 2 : 1,
        });
        const lifecycle = new LoopLifecycle(db);
        const rail = new StrikeRail(db);

        if (priorStrike) {
            assert.equal((await run()).result.status, 202);
            assert.equal(await rail.streak(loopId), 1);
            assert.equal(await lifecycle.wake(loopId), true);
            assert.equal(await rail.streak(loopId), 1, "waking does not forgive an earlier contract violation");
        }
        for (let join = 0; join < 2; join++) {
            assert.equal((await run()).result.status, 202, "a not-yet-ready child is a valid join, not a contract failure");
            assert.equal(await rail.streak(loopId), 0, "a clean collect follows ordinary clean-turn accounting");
            assert.equal(provider.received.length, Number(priorStrike) + join + 1, "no model polling occurs while parked");
            if (join === 0) assert.equal(await lifecycle.wake(loopId), true);
        }

        await lifecycle.finish(childLoop, TerminalResult.success("42"));
        assert.equal(await lifecycle.wake(loopId), true);
        const result = await run();
        assert.equal(result.result.status, 200);
        assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, loopId), "42");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId });
        const reads = rows.filter(({ op }) => op === "READ");
        const unfinished = reads.filter(({ status_rx }) => status_rx === 425);
        assert.equal(unfinished.length, 2, "the original not-ready receipts are not erased or relabeled");
        for (const row of unfinished) {
            assert.equal(JSON.parse(row.rx).problem.type, "https://problems.plurnk.xyz/scheme/ops/loop-running");
        }
        assert.ok(reads.some(({ status_rx, rx }) => status_rx === 200 && JSON.parse(rx).content === "42"),
            "resumption collects the child's actual terminal response");
    });
}

test("{§engine-rails} a valid join does not excuse another operation's contract failure", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "join-with-failure");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Collect the child answer.");
    const childId = await insertSession(db, workspaceId, sessionId, "child");
    await insertLoop(db, childId, 1, "Compute the answer.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(`${extraSlotCopy}\n${collect}`)] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 2, maxStrikes: 1,
    });
    assert.equal(result.result.status, 500);
    assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
    assert.equal(await new StrikeRail(db).streak(loopId), 1);
    const rows = await db.test_log_entries_by_loop.all<{ status_rx: number }>({ loop_id: loopId });
    assert.ok(rows.some(({ status_rx }) => status_rx === 425), "the valid join receipt survives");
    assert.ok(rows.some(({ status_rx }) => status_rx === 400), "the unrelated invalid pattern survives");
});

test("{§join-blocking-collect} the daemon wakes a collecting parent on actual child completion without consuming a strike", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        response("````WAIT\nAwait instructions.\n````"),
        response(collect),
        response("````SEND [200]\nChild answer: 42.\n````\n\n````SEND [200]\nFollow-up acknowledged.\n````"),
        response("````SEND [200]\nChild answer received: 42.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "join-wake-rails" });
        const parentId = await namedModelSession(daemon, workspaceId, "main");
        const parentSession = await daemon.readSession({ workspaceId, identity: { id: parentId } });
        assert.ok(parentSession);
        const { sessionId: childId } = await daemon.forkSession({ workspaceId, sessionId: parentId, name: "child" });
        const held = await holdChild(db, workspaceId, childId);
        const lifecycle = new LoopLifecycle(db);
        try {
            const child = await daemon.runLoop({ workspaceId, sessionId: childId, prompt: "Wait, then answer.", source: `session://${parentSession.name}` });
            await waitForDb(() => lifecycle.status(child.loopId), (status) => status === 202);
            const parent = await daemon.runLoop({ workspaceId, sessionId: parentId, prompt: "Collect the child's answer." });
            await waitForDb(() => lifecycle.status(parent.loopId), (status) => status === 202);
            await lifecycle.finish(held, TerminalResult.success("The held dependency completed."));
            // {§session-obligations} main's own operation sends the follow-up, so the reply to it is main's.
            const resumed = await daemon.inject({
                workspaceId, sessionId: childId, prompt: "Answer now.", source: `session://${parentSession.name}`,
                providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" }, effort: "adaptive", systemPrompt: "test system",
                opener: await sendingOperation(db, parent.loopId),
            });
            assert.equal(resumed.loopId, child.loopId);
            await waitForDb(() => lifecycle.status(parent.loopId), (status) => status === 200);
            assert.equal((await lifecycle.result(parent.loopId))?.content, undefined);
            assert.equal(await lastReply(db, parent.loopId), "Child answer received: 42.");
            assert.equal(provider.received.length, 4, "actual child completion resumes the same parent loop exactly once");
            const parentRail = await db.test_strike_streak.get<{ strike_streak: number }>({ loop_id: parent.loopId });
            assert.equal(parentRail?.strike_streak, 0, "neither the join nor its wake consumes recovery allowance");
            const delivered = await db.test_log_entries_by_loop.all<{ tx: string; attrs: string; initial_folded: string; folded: string }>({ loop_id: parent.loopId });
            // {§loop-answer}: the child's answer to its parent's own task arrives as the conclusion.
            const conclusion = delivered.find(({ attrs }) => JSON.parse(attrs).kind === "loop_termination");
            assert.ok(conclusion);
            assert.equal(conclusion.initial_folded, "[]", JSON.stringify(conclusion));
            assert.equal(conclusion.folded, "[]", JSON.stringify(conclusion));
            assert.deepEqual(delivered.filter(({ attrs }) => JSON.parse(attrs).kind === "reply").map(({ tx }) => JSON.parse(tx).body.raw),
                ["Follow-up acknowledged."], "the follow-up gets its own reply; the original child answer is not duplicated");
            assert.match(JSON.stringify(provider.received.at(-1)), /Child answer: 42\./,
                "the resumed parent packet contains the child's completed response");
            assert.equal(await new StrikeRail(db).streak(parent.loopId), 0);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: parent.loopId });
            assert.ok(rows.some(({ op, status_rx }) => op === "READ" && status_rx === 425));
        } finally {
            await daemon.cancelSession({ workspaceId, sessionId: parentId });
        }
    });
});
