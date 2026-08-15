// Tight-pressure model demo. The communicated gauge is derived from this fixture's
// measured packet floor. Deterministic grinder behavior has integration coverage;
// this story checks that a real model can gather the requested facts and conclude.

import test from "node:test";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop, pinAliasInputCapacity } from "../_live-harness.ts";
import { measureFloor } from "./_floor-probe.ts";
import { seedDemoFixture } from "./_fixture.ts";

const GAUGE_FACTOR = 1.6;

test("demo: complete a multi-source briefing under tight context pressure", async () => {
    const fixture = await seedDemoFixture("budget");
    // The codename lives in notes.md and nowhere else; naming the record keeps
    // the briefing a retrieval task rather than a guess at the package name.
    const userPromptText = "Brief me on this project — the codename recorded in notes.md, the database host it connects to, and the one outstanding TODO in the app code.";
    const floor = await measureFloor({ label: "grind", projectRoot: fixture.workspace, prompt: userPromptText });
    const gauge = Math.round(floor.weight * GAUGE_FACTOR);
    const restore = pinAliasInputCapacity({ inputCapacity: gauge, outputBudget: floor.outputBudget });
    try {
        const s = await liveWorkspace({ name: `demo-budget-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        try {
            const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: userPromptText }, { timeoutMs: 240_000 });
            console.error(`[budget-grind] floor=${floor.weight} requestedCapacity=${gauge} effectiveCapacity=${s.provider.inputCapacity} outputBudget=${s.provider.outputBudget} turns=${turnIds.length} finalStatus=${finalStatus}`);

            assert.equal(finalStatus, 200, "model completes the briefing under the communicated pressure gauge");
            assert.match(lastContent, /phoenix/i, "briefing reports the project codename");
            assert.match(lastContent, /db\.internal/i, "briefing reports the database host");
            assert.match(lastContent, /error handling/i, "briefing reports the outstanding TODO");
        } finally { await s.cleanup(); }
    } finally {
        restore();
        await fixture.cleanup();
    }
});
