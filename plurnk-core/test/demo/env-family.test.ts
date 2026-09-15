// {§exec-env-scoped} {§functionality-scope} — the env family as a model actually meets it.
//
// These two stories exist because correctness tests cannot answer the question the feature is
// for: can a model find the environment surface and use it without being told the verbs? They
// were written against the agreed interface BEFORE the adapter, so the adapter has a target
// rather than a retrofit.
import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";

// Story one: the configuration travel guide, and the security boundary, in one run.
//
// The model must DISCOVER a credential's name rather than guess it, and must not be able to read
// its value. The operator's host genuinely has TAVILY_API_KEY set, so the "no value" assertion is
// live evidence that the catalog projects declarations rather than the environment — the exact
// property that makes "values it needs from the operator are referred to by name" true.
test("demo: the model finds a credential's name in the catalog and asks for it by name", async (t) => {
    // The no-leak assertion below is only evidence when the host holds a real value; without one it
    // would pass vacuously, so the story skips — before any model spend — rather than pretending.
    const operatorValue = process.env.TAVILY_API_KEY ?? "";
    if (operatorValue.length === 0) {
        t.skip("needs TAVILY_API_KEY on the host to be evidence");
        return;
    }
    const s = await liveWorkspace({ name: `env-discover-${crypto.randomUUID()}` });
    try {
        const loop = await liveLoop(
            s, 1,
            {
                prompt: "You need to use Tavily for a web search, but its search credential is not configured. "
                    + "Find out which environment variable supplies it and what it is for, then tell me "
                    + "its exact name and purpose. Do not guess the name — find it.",
                maxTurns: 12,
            },
            { signal: t.signal },
        );
        assert.equal(loop.finalStatus, 200, "loop terminated cleanly");
        assert.match(loop.lastContent, /TAVILY_API_KEY/u, "the model found the name in the catalog rather than guessing");

        // The operator's real value must never appear.
        assert.doesNotMatch(loop.lastContent, new RegExp(operatorValue.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
            "the catalog projects the DECLARATION; an operator's value must never reach the model");
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
