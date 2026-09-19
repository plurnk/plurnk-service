// {§loop-attendance} — the conversational half of the unattended contract. A unit test can prove
// the daemon refuses to ask; only a live model can answer the question that actually matters:
// having been told nobody is there, does the model RECOVER — conclude on what it has and say what
// it could not resolve — or does it re-ask, spiral, and burn its strikes?
//
// This is the tier the operator has named repeatedly: a refusal the model cannot act on is worse
// than the hang it replaced, because it looks like progress. The first version of this behaviour
// handed the model "The 'question' executor failed outside its operation result contract", which is
// exactly the shape that gets tolerated in a benchmark and is intolerable in a conversation.
//
// Strict by design: a strike, an empty turn, a fabricated answer, or a second attempt to ask is a
// failure here even when the final text reads well.

import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";
import { failAfterCleanup } from "../live-failure.ts";
import WorldState from "../intg/world-state.ts";

// A task that genuinely invites asking: the fixture does not say which branch, and no amount of
// reading will tell it. An attended run may reasonably ask; an unattended one must decide and say so.
const AMBIGUOUS = "Update the project so it targets the right release branch, then tell me what you did."
    + " If anything is ambiguous, ask me before guessing.";

test("conversation: told nobody is there, plurnk decides and says what it could not resolve", { timeout: 600_000 }, async (t) => {
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
            policy: { proposals: "accept", attended: false },
        }, { signal: t.signal });

        const rows = await s.db.test_log_entries_by_worker.all<{ op: string | null; origin: string; status_rx: number }>({ worker_id: loop.modelWorkerId });
        const model = rows.filter(({ origin }) => origin === "model");
        const asked = model.filter(({ op }) => op === "question");

        assert.deepEqual(await WorldState.check(s.db), [], "the world stays lawful");

        // It ends on its own terms. A loop that parked or struck out would not be 200.
        assert.equal(loop.finalStatus, 200, "an unattended run concludes rather than parking or striking out");
        assert.equal(loop.hitMaxTurns, false, "and does so without exhausting its turns");
        assert.ok(loop.lastContent.length > 0, "an answer actually arrives");

        // The heart of it: asking is refused once and understood, never retried into a spiral.
        for (const attempt of asked) {
            assert.equal(attempt.status_rx, 501, "every attempt to ask is refused with the reason, not an executor contract error");
        }
        assert.ok(asked.length <= 1, `the refusal is understood on the first reading; the model asked ${asked.length} times`);

        // Having been refused, it must say what it could not settle rather than inventing a fact.
        if (asked.length === 1) {
            assert.match(
                loop.lastContent,
                /could not|couldn't|unable|no one|nobody|unattended|assumed|chose|picked|defaulted/i,
                "the reply names the unresolved choice or the assumption it made instead of stating one as fact",
            );
        }
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    } finally { await cleanup(); }
});
