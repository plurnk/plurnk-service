// {§loop-attendance} — a run that declares nobody is attending must never stop at a wait only a
// human could end. Measured cost of the gap (plurnk-bench dumbox-20260918, run4): after two 600 s
// provider cuts the root loop parked at 17:53:32 and the client's own clock cancelled it at
// 18:48:02 — 54 minutes 30 seconds of an 88-minute budget spent in silence, because
// `LoopLifecycle.park` stops the execution clock and no wake timer arms without an open stream.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ClientInteractions from "../../src/core/ClientInteractions.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

const downProvider = (): Mock => {
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    provider.generate = async () => { throw new ProviderError("plurnk", "network_failure", "connection refused"); };
    return provider;
};

for (const attended of [true, false]) {
    test(`{§loop-attendance} an exhausted provider recovery ${attended ? "parks an attended loop" : "concludes an unattended one"}`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, `attendance-${attended}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go", { proposals: attended ? "review" : "accept", attended });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const run = await engine.runLoop({
            workspaceId, workerId, loopId, provider: downProvider(), messages: [], maxTurns: 2,
        });
        const lifecycle = new LoopLifecycle(db);

        if (attended) {
            assert.equal(run.result.status, 202, "someone is here: the loop parks and waits to be woken");
            assert.equal(run.reason, "provider_unavailable");
            assert.equal(await lifecycle.status(loopId), 202);
            assert.equal(await lifecycle.result(loopId), null, "a parked loop has no terminal result");
            return;
        }

        // Nobody is coming, and parking would stop the only clock that could end this.
        assert.equal(run.result.status, 503, "the loop ends on the provider's own failure");
        assert.equal(run.reason, "provider_unavailable", "and says which rail ended it");
        assert.equal(run.result.problem?.type, "https://problems.plurnk.xyz/provider/plurnk/network-failure");
        assert.equal(run.result.problem?.detail, "connection refused",
            "the provider's exact failure is the conclusion, never a substituted 'the model gave up'");
        assert.notEqual(await lifecycle.status(loopId), 202, "an unattended loop never rests at 202");
        assert.equal((await lifecycle.result(loopId))?.status, 503, "and its result is durable");
    });
}

test("{§loop-attendance} the recovery notice promises a wake only when one can arrive", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "attendance-notices");
    const said: string[] = [];
    const engine = new Engine({
        db, schemes: new SchemeRegistry(),
        noticeNotify: (_sid, payload) => {
            const { notice } = payload as { notice: { source: string; level: string; message: string } };
            if (notice.source === "engine:provider" && notice.level === "error") said.push(notice.message);
        },
    });
    for (const attended of [true, false]) {
        const workerId = await insertWorker(db, workspaceId, null, `w-${attended}`);
        const loopId = await insertLoop(db, workerId, 1, "go", { proposals: "accept", attended });
        await engine.runTurn({ provider: downProvider(), workspaceId, workerId, loopId, messages: [] });
    }
    assert.equal(said.length, 2);
    assert.match(said[0]!, /parked and resumes on the next prompt or wake/, "attended: the wake is real");
    assert.match(said[1]!, /unattended, so the loop ends here/, "unattended: no promise of a resumption nobody can deliver");
});

test("{§loop-attendance} an unattended run is refused an interactive partner, not left waiting for one", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "attendance-interaction");
    const interactions = new ClientInteractions(db);
    const request = {
        toolName: "question",
        message: "Which branch should I target?",
        arguments: { message: "Which branch should I target?" },
        responseSchema: { type: "object" },
    };

    const ask = async (attended: boolean, name: string): Promise<{ promise: Promise<unknown>; loopId: number }> => {
        const workerId = await insertWorker(db, workspaceId, null, name);
        const loopId = await insertLoop(db, workerId, 1, "go", { proposals: "accept", attended });
        const turnId = await insertTurn(db, loopId, 1);
        return { promise: interactions.request(request, { workspaceId, workerId, loopId, turnId }), loopId };
    };

    // The request becomes discoverable once it is registered; a bounded wait for that beats a
    // guessed number of ticks.
    const discoverable = async (): Promise<number> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const pending = await interactions.list(workspaceId);
            if (pending.length > 0) return pending.length;
            await new Promise((resolve) => setImmediate(resolve));
        }
        return 0;
    };

    // Attended, the request is written down and waits — so it is never awaited here.
    const waiting = await ask(true, "attended-asker");
    let settled = false;
    void waiting.promise.then(() => { settled = true; }, () => { settled = true; });
    assert.equal(await discoverable(), 1, "attended: the question is discoverable by the client that must answer it");
    assert.equal(settled, false, "and it waits for that answer rather than resolving itself");

    // Unattended, it is refused at the point of use — every wiring (the question tool, the exec
    // bridge, the scheme caps, MCP elicitation) funnels through this one request.
    const refused = await ask(false, "unattended-asker");
    const status = await refused.promise.then(() => 0, (error: { result?: { status?: number; problem?: { detail?: string } } }) => error.result);
    assert.equal((status as { status?: number }).status, 501, "asking is not available when nobody is there to answer");
    assert.equal((status as { problem?: { detail?: string } }).problem?.detail, "This run is unattended: nobody is present to answer.");
    assert.equal((await interactions.list(workspaceId)).length, 1, "and no second row was written down for nobody");
});
