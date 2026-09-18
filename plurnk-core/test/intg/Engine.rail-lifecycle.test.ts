import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel } from "./_helpers.ts";

const response = (operation: string, op: string, timing = "") => ({
    assistant: { content: [
        operation,
        PlurnkParser.frame(`${op}${timing}`, ""),
    ].join("\n"), reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
const invalidFind = "````FIND (worker:///x) [{\"pattern\":\"$fC\"}]````";

test("{§loop-rail-continuity}: a resumed task retains its strike streak across a wait and engine reconstruction", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "wait-streak-continuity");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Read the answer and conclude.");
    const childId = await insertWorker(db, workspaceId, workerId, "child");
    await insertLoop(db, childId, 1, "Live child work the wait joins.");
    await seedEntryWithChannel(db, {
        workspaceId, scheme: "worker", pathname: "/answer", channel: "body",
        content: "42", mimetype: "text/plain", state: "static",
    });
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(invalidFind, "NOTE"),
        response(invalidFind, "WAIT"),
        response(invalidFind, "NOTE"),
    ] });
    const run = () => new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4, maxStrikes: 3,
    });
    assert.equal((await run()).result.status, 202, "two operation-contract strikes, then the park");
    assert.equal(await new LoopLifecycle(db).wake(loopId), true);
    const resumed = await run();
    assert.equal(resumed.result.status, 500, "the third strike crosses the threshold: the streak survived the wait and the engine reconstruction");
    assert.equal(resumed.reason, "strike_threshold");
    assert.equal(provider.received.length, 3);
});

test("{§worker-lifecycle-state-machine}: cancellation wins against a pending strike verdict", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "rail-cancel-race");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Perform work.");
    const lifecycle = new LoopLifecycle(db);
    const assess = StrikeRail.prototype.assess;
    t.mock.method(StrikeRail.prototype, "assess", async function (this: StrikeRail, ...args: Parameters<typeof assess>) {
        const verdict = await assess.apply(this, args);
        if (args[0] === loopId && verdict.thresholdCrossed) {
            await lifecycle.finish(loopId, Results.failure("daemon:loop", "cancelled", 499, "Cancelled by the client."), { terminatedBy: "cancel" });
        }
        return verdict;
    });
    const provider = new Mock({ contextWindow: 100000, responses: [response(invalidFind, "NOTE")] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 2, maxStrikes: 1,
    });
    assert.equal(result.result.status, 499);
    assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/daemon/loop/cancelled");
    assert.equal(result.reason, "external", "the losing rail verdict reports the committed cancellation, not its intended failure");
});
