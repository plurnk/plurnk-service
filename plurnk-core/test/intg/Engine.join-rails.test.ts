import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import TerminalResult from "../../src/core/TerminalResult.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";

const response = (content: string) => ({
    assistant: { content, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
const collect = "```READ (worker://child)```\n```NEXT\n[{\"content\":\"Collect the child result.\",\"status\":\"in_progress\"}]\n```";
const invalidFind = "```FIND (worker:///x)\n$fC\n```";

for (const priorStrike of [false, true]) {
    test(`{§join-blocking-collect} a complete-loop collect parks without a strike${priorStrike ? " after prior failure" : " at maxStrikes=1"}`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "join-rails");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Collect the child answer.");
        const childId = await insertWorker(db, workspaceId, workerId, "child");
        const childLoop = await insertLoop(db, childId, 1, "Compute the answer.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            ...(priorStrike ? [response(`${invalidFind}\n\`\`\`WAIT <60>\`\`\``)] : []),
            response(collect),
            response(collect),
            response(collect),
            response("```DONE\n42\n```"),
        ] });
        const run = () => new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            workspaceId, workerId, loopId, provider, messages: [], maxTurns: 8, maxStrikes: priorStrike ? 2 : 1,
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
        assert.equal(result.result.content, "42");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId });
        const reads = rows.filter(({ op }) => op === "READ");
        const unfinished = reads.filter(({ status_rx }) => status_rx === 425);
        assert.equal(unfinished.length, 2, "the original not-ready receipts are not erased or relabeled");
        for (const row of unfinished) {
            assert.equal(JSON.parse(row.rx).problem.type, "https://problems.plurnk.xyz/scheme/worker/worker-unfinished");
        }
        assert.ok(reads.some(({ status_rx, rx }) => status_rx === 200 && JSON.parse(rx).content === "42"),
            "resumption collects the child's actual terminal response");
    });
}

test("{§engine-rails} a valid join does not excuse another operation's contract failure", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "join-with-failure");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Collect the child answer.");
    const childId = await insertWorker(db, workspaceId, workerId, "child");
    await insertLoop(db, childId, 1, "Compute the answer.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(`${invalidFind}\n${collect}`)] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 2, maxStrikes: 1,
    });
    assert.equal(result.result.status, 500);
    assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
    assert.equal(await new StrikeRail(db).streak(loopId), 1);
    const rows = await db.test_log_entries_by_loop.all<{ status_rx: number }>({ loop_id: loopId });
    assert.ok(rows.some(({ status_rx }) => status_rx === 425), "the valid join receipt survives");
    assert.ok(rows.some(({ status_rx }) => status_rx === 400), "the unrelated invalid pattern survives");
});

test("{§join-blocking-collect} the daemon wakes a collecting parent on actual child completion without consuming a strike", async (t) => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        response("```WAIT <60>\nAwait instructions.\n```"),
        response(collect),
        response("```DONE\nChild answer: 42.\n```"),
        response("```DONE\nChild answer received: 42.\n```"),
    ] });
    const strikes: Array<number | undefined> = [];
    const generate = provider.generate.bind(provider);
    t.mock.method(provider, "generate", (args: Parameters<Mock["generate"]>[0]) => {
        strikes.push(args.strikes);
        return generate(args);
    });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "join-wake-rails" });
        const parentId = await daemon.ensureModelWorker(workspaceId);
        const { workerId: childId } = await daemon.forkWorker({ workspaceId, workerId: parentId, name: "child" });
        const lifecycle = new LoopLifecycle(db);
        try {
            const child = await daemon.runLoop({ workspaceId, workerId: childId, prompt: "Wait, then answer." });
            await waitForDb(() => lifecycle.status(child.loopId), (status) => status === 202);
            const parent = await daemon.runLoop({ workspaceId, workerId: parentId, prompt: "Collect the child's answer." });
            await waitForDb(() => lifecycle.status(parent.loopId), (status) => status === 202);
            const resumed = await daemon.runLoop({ workspaceId, workerId: childId, prompt: "Answer now." });
            assert.equal(resumed.loopId, child.loopId);
            await waitForDb(() => lifecycle.status(parent.loopId), (status) => status === 200);
            assert.equal((await lifecycle.result(parent.loopId))?.content, "Child answer received: 42.");
            assert.equal(provider.received.length, 4, "actual child completion resumes the same parent loop exactly once");
            assert.deepEqual(strikes, [0, 0, 0, 0], "neither the join nor its wake consumes recovery allowance");
            assert.match(JSON.stringify(provider.received.at(-1)), /Child answer: 42\./,
                "the resumed parent packet contains the child's completed response");
            assert.equal(await new StrikeRail(db).streak(parent.loopId), 0);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: parent.loopId });
            assert.ok(rows.some(({ op, status_rx }) => op === "READ" && status_rx === 425));
        } finally {
            await daemon.cancelWorker({ workspaceId, workerId: parentId });
        }
    });
});
