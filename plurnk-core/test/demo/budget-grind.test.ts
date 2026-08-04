// Tight-budget model demo. The communicated ceiling is derived from this fixture's
// measured packet floor and is the only threshold asserted. Deterministic grinder
// behavior has integration coverage; this story checks that a real model can gather
// the requested facts and conclude within the budget it was actually shown.

import test from "node:test";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop, pinAliasBudget } from "../_live-harness.ts";
import { measureFloor } from "./_floor-probe.ts";
import { seedDemoFixture } from "./_fixture.ts";

const CEILING_FACTOR = 1.6;
const REASONING_RESERVE = 1;
const COMPLETION_RESERVE = 8192;

test("demo: complete a multi-source briefing under a tight prompt budget", async () => {
    const fixture = await seedDemoFixture("budget");
    const userPromptText = "Brief me on this project — its codename, the database host it connects to, and the one outstanding TODO in the app code.";
    // Pin the absolute response envelope before both phases; the virtual prompt budgets below
    // alter only the model-facing gauge and grinder.
    const restoreReserves = pinAliasBudget({ REASONING: String(REASONING_RESERVE), COMPLETION: String(COMPLETION_RESERVE), SAFETY: "0" });
    const floor = await measureFloor({ label: "grind", projectRoot: fixture.workspace, prompt: userPromptText });
    const CEILING = Math.round(floor * CEILING_FACTOR);
    const restore = pinAliasBudget({ PROMPT_BUDGET: String(CEILING) });
    try {
        const s = await liveWorkspace({ name: `demo-budget-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        try {
            const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: userPromptText }, { timeoutMs: 240_000 });

            // #74 owns replacement of this section-sum proxy with production
            // slot rendering, which includes separators and rounds each slot once.
            let peak = 0;
            for (const tid of turnIds) {
                const row = await s.db.test_get_turn.get<{ packet: string }>({ id: tid });
                const p = JSON.parse(row?.packet ?? "{}") as { sections?: Array<{ tokens?: number }> };
                peak = Math.max(peak, (p.sections ?? []).reduce((n, sec) => n + (sec.tokens ?? 0), 0));
            }
            console.error(`[budget-grind] floor=${floor} ceiling=${CEILING} turns=${turnIds.length} finalStatus=${finalStatus} peakTotal=${peak}`);

            assert.equal(finalStatus, 200, "model completes the briefing under the communicated ceiling");
            assert.ok(peak <= CEILING, `delivered request peaked at ${peak}, above the communicated ceiling ${CEILING}`);
            assert.match(lastContent, /phoenix/i, "briefing reports the project codename");
            assert.match(lastContent, /db\.internal/i, "briefing reports the database host");
            assert.match(lastContent, /error handling/i, "briefing reports the outstanding TODO");
        } finally { await s.cleanup(); }
    } finally {
        restore();
        restoreReserves();
        await fixture.cleanup();
    }
});
