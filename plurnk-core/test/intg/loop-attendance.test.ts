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
import CapabilityPolicies from "../../src/core/CapabilityPolicies.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";

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

// {§loop-attendance} — the rule lives at the park owner, so a future park site that forgets
// attendance fails loudly on its first unattended run instead of idling until a caller's clock
// notices. LoopDriver concludes before it reaches this, so on the shipped paths it never fires.
test("{§loop-attendance} parking an unattended loop with no waker is a contract violation", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "attendance-park-tripwire");
    const workerId = await insertWorker(db, workspaceId);
    const lifecycle = new LoopLifecycle(db);

    const unattended = await insertLoop(db, workerId, 1, "go", { proposals: "accept", attended: false });
    await assert.rejects(
        () => lifecycle.park(unattended, { wakenBy: null }),
        /cannot park with no waker in an unattended run; conclude instead/,
    );
    assert.notEqual(await lifecycle.status(unattended), 202, "and nothing was parked");

    // A named waker is the whole difference: an obligation requeues the loop, a human does not.
    assert.equal(await lifecycle.park(unattended, { wakenBy: "obligations" }), true,
        "an unattended loop still parks on a real waker — a WAIT, an open stream, a delegated child");
    const attended = await insertLoop(db, workerId, 2, "go", { proposals: "review", attended: true });
    assert.equal(await lifecycle.park(attended, { wakenBy: null }), true,
        "and an attended loop may park on nothing but a person, because a person can arrive");
});

// {§worker-delegation-inherits-policy} already carries the whole policy to a fresh delegated loop;
// this proves the inherited half is load-bearing, not decorative — the child BEHAVES unattended.
test("{§loop-attendance} a child that inherited an unattended policy concludes rather than parking", async () => {
    await withDaemon(downProvider(), async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: `attendance-inheritance-${crypto.randomUUID()}` });
        const parent = await daemon.ensureModelWorker(workspaceId);
        const accepted = await daemon.inject({
            workspaceId,
            workerId: parent,
            prompt: "delegated work",
            providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            reasoningPolicy: "adaptive",
            systemPrompt: "test system",
            // Exactly what Worker.ts passes when a parent delegates: the parent's own policy.
            freshLoopPolicy: { proposals: "accept", attended: false },
        });
        await accepted.drainPromise;
        const lifecycle = new LoopLifecycle(db);
        // Its provider was down for every attempt; the recovery budget is spent.
        await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 200 || status >= 400);
        assert.notEqual(await lifecycle.status(accepted.loopId), 202,
            "a delegated child never rests at 202 for a human its parent never had");
        assert.equal((await lifecycle.result(accepted.loopId))?.status, 503,
            "it ends on the provider's own failure, which is what the parent's WAIT then collects");
    });
});

// {§loop-attendance} {§worker-tool-admission} — the loop is the capability cascade's innermost
// ring (#770). An unattended run denies the `interact` access class, so dispatch refuses an
// interaction runtime and names WHICH ring refused it: a tool that vanished says why.
test("{§loop-attendance} an unattended loop denies the interact access class at its own ring", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "attendance-capability-ring");
    const workerId = await insertWorker(db, workspaceId);
    const attended = await insertLoop(db, workerId, 1, "go", { proposals: "review", attended: true });
    const unattended = await insertLoop(db, workerId, 2, "go", { proposals: "accept", attended: false });

    const rings = async (loopId?: number): Promise<string[]> =>
        (await CapabilityPolicies.layers(db, workspaceId, loopId)).map(({ scope }) => scope);

    assert.deepEqual(await rings(), ["service", "workspace"],
        "a question about the workspace carries no loop ring — the operator's projection and the shared document tree");
    assert.deepEqual(await rings(attended), ["service", "workspace"],
        "an attended run adds nothing: someone is there, so nothing is subtracted");
    assert.deepEqual(await rings(unattended), ["service", "workspace", "loop"],
        "an unattended run adds its own innermost ring");

    const loopRing = (await CapabilityPolicies.layers(db, workspaceId, unattended)).at(-1)!;
    assert.deepEqual(loopRing.policy, { deny: [{ access: "interact" }] },
        "and that ring subtracts exactly the access class that needs a person, nothing else");
    // Purely subtractive, like every other layer: it can never widen what the workspace allows.
    assert.equal("only" in loopRing.policy, false);
});
