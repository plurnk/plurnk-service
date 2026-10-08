// {§owner-interaction-ring} — the conversational half of the unattended contract. A harness worker is
// owned by the runtime, which nobody attends, so nothing can answer a question. Given an ambiguous
// task, a good run decides, finishes on its own, and says what it decided. Like every story, it is
// judged by the outcome a person would read, never by which operations got it there.

import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";
import { failAfterCleanup } from "../live-failure.ts";
import WorldState from "../intg/world-state.ts";

// Genuinely ambiguous: the fixture does not say which branch, and no amount of reading will tell it.
// Nothing in the prompt invites asking; the model has to notice the gap itself.
const AMBIGUOUS = "Update the project so it targets the right release branch, then tell me what you did.";

test("conversation: with nobody to ask, plurnk decides and says what it could not resolve", { timeout: 600_000 }, async (t) => {
    const fixture = await seedDemoFixture("unattended-recovery");
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = (): Promise<void> => lifetime.disposeAsync();
    try {
        const s = await liveWorkspace({ name: `demo-unattended-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        const loop = await liveLoop(s, 2, {
            prompt: AMBIGUOUS,
            maxTurns: 8,
        }, { signal: t.signal });

        assert.deepEqual(await WorldState.check(s.db), [], "the world stays lawful");
        assert.equal(loop.finalStatus, 200, "an unattended run finishes on its own");
        assert.equal(loop.hitMaxTurns, false, "without exhausting its turns");
        assert.ok(loop.lastContent.length > 0, "an answer actually arrives");
        assert.match(
            loop.lastContent,
            /could not|couldn't|unable|unclear|ambiguous|no one|nobody|assumed|assuming|chose|picked|defaulted/i,
            "and it owns the choice it made instead of stating a guess as fact",
        );
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    } finally { await cleanup(); }
});
