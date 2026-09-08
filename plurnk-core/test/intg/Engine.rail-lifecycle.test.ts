import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel } from "./_helpers.ts";

const response = (operation: string, disposition: string) => ({
    assistant: { content: [
        PlurnkParser.frame("PLAN", "[]"),
        operation,
        PlurnkParser.frame(disposition.split("\n")[0], disposition.includes("\n") ? disposition.slice(disposition.indexOf("\n") + 1) : null),
    ].join("\n"), reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
const invalidFind = "```FIND (worker:///x)\n$fC\n```";

test("{§loop-rail-continuity}: a resumed task retains its final-strike retrieval allowance", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "wait-final-allowance");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Read the answer and conclude.");
    await seedEntryWithChannel(db, {
        workspaceId, scheme: "worker", pathname: "/answer", channel: "body",
        content: "42", mimetype: "text/plain", state: "static",
    });
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(invalidFind, "NEXT"),
        response(invalidFind, "WAIT <60>"),
        response("```READ (worker:///answer)```", "DONE\n42"),
    ] });
    const run = () => new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4, maxStrikes: 3,
    });
    assert.equal((await run()).result.status, 202);
    assert.equal(await new LoopLifecycle(db).wake(loopId), true);
    assert.equal((await run()).result.status, 200, "the third-strike allowance is the same after a wait and engine reconstruction");
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
    const provider = new Mock({ contextWindow: 100000, responses: [response(invalidFind, "NEXT")] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 2, maxStrikes: 1,
    });
    assert.equal(result.result.status, 499);
    assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/daemon/loop/cancelled");
    assert.equal(result.reason, "external", "the losing rail verdict reports the committed cancellation, not its intended failure");
});
