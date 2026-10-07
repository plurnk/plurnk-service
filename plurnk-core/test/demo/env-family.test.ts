// {§exec-env-scoped} {§functionality-scope} — the env family as a model actually meets it.
//
// These two stories exist because correctness tests cannot answer the question the feature is
// for: can a model find the environment surface and use it without being told the verbs? They
// were written against the agreed interface BEFORE the adapter, so the adapter has a target
// rather than a retrofit.
import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";

// Story one: a value already in the worker's environment, asked for plainly.
test("demo: the model reads a variable already in its worker's environment", async (t) => {
    const s = await liveWorkspace({ name: `env-read-${crypto.randomUUID()}` });
    try {
        const workerId = await s.daemon.ensureModelWorker(s.workspaceId);
        await s.daemon.invokeModuleAction("worker.env.add", { alias: "FOO_VERSION", definition: { value: "42" } },
            { scope: "worker", workspaceId: s.workspaceId, workerId });
        const loop = await liveLoop(s, 1, { prompt: "What's the FOO_VERSION environment variable?", workerId, maxTurns: 6 }, { signal: t.signal });
        assert.equal(loop.finalStatus, 200, "loop terminated cleanly");
        assert.match(loop.lastContent, /\b42\b/u, "the reply gives the value the worker's environment holds");
    } finally { await s.cleanup(); }
});

// Story two: a registry rather than a prefix.
//
// The discriminating assertion is the SECOND command. A model that sets the variable inline
// (`CARGO_TARGET_DIR=… cmd`) satisfies the first half and fails here, which is precisely the
// difference between an ephemeral prefix and durable worker state.
test("demo: a value the model sets persists into a later command", async (t) => {
    const s = await liveWorkspace({ name: `env-persist-${crypto.randomUUID()}` });
    try {
        const loop = await liveLoop(
            s, 1,
            {
                prompt: "Configure your environment so that CARGO_TARGET_DIR is /tmp/plurnk-demo-shared "
                    + "for every command you run from now on — not just one. Afterwards, in a separate "
                    + "later step, run a command that prints CARGO_TARGET_DIR and report exactly what it printed.",
                maxTurns: 16,
            },
            { signal: t.signal },
        );
        assert.equal(loop.finalStatus, 200, "loop terminated cleanly");
        assert.match(loop.lastContent, /\/tmp\/plurnk-demo-shared/u,
            "the later command saw the value, so it came from the worker's registry and not an inline prefix");
        assert.ok(loop.turnIds.length >= 2, "setting and observing are separate turns; one turn cannot distinguish the two");
    } finally { await s.cleanup(); }
});
