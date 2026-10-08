// {§owner-interaction-ring} — the conversational half of the unattended contract. A harness worker is
// owned by the runtime, which nobody attends, so it is never offered a way to ask. Integration tests
// prove the tool is absent; only a live model can show what matters: given an ambiguous task and
// nobody to ask, does it decide, say what it could not resolve, and finish, or does it improvise a
// wait for a person that no operation provides?
//
// Strict by design: a strike, an empty turn, an attempt to ask, a WAIT with nothing in flight, or a
// guess stated as fact is a failure here even when the final text reads well.

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

        const rows = await s.db.test_log_entries_by_worker.all<{ op: string | null; origin: string; status_rx: number }>({ worker_id: loop.modelWorkerId });
        const model = rows.filter(({ origin }) => origin === "model");

        assert.deepEqual(await WorldState.check(s.db), [], "the world stays lawful");

        // It ends on its own terms. A loop that parked or struck out would not be 200.
        assert.equal(loop.finalStatus, 200, "an unattended run concludes rather than parking or striking out");
        assert.equal(loop.hitMaxTurns, false, "and does so without exhausting its turns");
        assert.ok(loop.lastContent.length > 0, "an answer actually arrives");

        // Nothing offered a way to ask, so nothing asks, and nothing waits for a person:
        // WAIT joins children and streams, and with nothing in flight it only continues (102).
        assert.deepEqual(model.filter(({ op }) => op === "question"), [], "an unattended worker is never offered the question tool");
        assert.deepEqual(model.filter(({ op, status_rx }) => op === "WAIT" && status_rx === 102), [],
            "the model never waits with nothing in flight");

        // The choice was the model's to make, so the reply must say it made one.
        assert.match(
            loop.lastContent,
            /could not|couldn't|unable|unclear|ambiguous|no one|nobody|assumed|assuming|chose|picked|defaulted/i,
            "the reply names the unresolved choice or the assumption it made instead of stating one as fact",
        );
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    } finally { await cleanup(); }
});
