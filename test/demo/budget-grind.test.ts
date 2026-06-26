// Extreme-budget demo — designed to FAIL until the model is taught to curate.
// PLURNK_BUDGET_CEILING is pinned just above the fixed sysprompt floor
// (plurnk.md ~1313t + persona/requirements), so a couple of file READs push
// the assembled packet past the wall. With no curation the log accumulates and
// `peak` blows the ceiling; staying under means the model HID earlier reads as
// it worked. The communicated ceiling is shrunk, not the real window, so this
// isolates "does the readout MOTIVATE curation" with no real-413 confound.
// Run + digest (bin/digest.ts) to analyze the failure together.
//
// Driven through the REAL prod loop (loop.run via the daemon). The ceiling is a
// tasteful .env tuning — set before liveSession boots the daemon so its engine
// captures it at construction; project_root + PLURNK_GIT_AUTO give the fixture's
// git files as members the production way (no hand-registered catalog).

import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { liveSession, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";

// Pinned above the assembled floor+catalog — measured as the turn-1 peak, which
// grew to ~1816 with grammar 0.20.0 + mimetypes 0.10.0's larger sysprompt (was
// ~1478) — and below the with-reads peak, so the model must read-distill-FOLD to
// answer rather than the grinder hard-stopping at the floor. Bump when the
// sysprompt grows again. Absolute mode (>1) holds though gemma reports no window.
// Pinned above the assembled floor, below the no-curation peak, so the model must read-distill-FOLD
// to stay under rather than the grinder hard-stopping at the floor. RECALIBRATED 2026-06-25 against
// grammar 0.74.20 / mimetypes 0.15.27 / schemes 0.30.9: the `definition` (sysprompt) section alone is
// now 1991t; the first full turn assembles at ~3102t and, with NO curation, the log section grows the
// packet to ~3785t over four turns. 3500 sits in that window. Bump again when the sysprompt grows.
const CEILING = 3500;

test("demo: budget grind — under a pinned ceiling, the model must curate to keep assembled context under budget", async () => {
    const fixture = await seedDemoFixture("budget");
    const prevCeiling = process.env.PLURNK_BUDGET_CEILING;
    process.env.PLURNK_BUDGET_CEILING = String(CEILING); // captured by the daemon's engine at construction (liveSession, below)
    try {
        const s = await liveSession({ name: `demo-budget-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        try {
            const userPrompt = "Brief me on this project — its codename, the database host it connects to, and the one outstanding TODO in the app code.";
            const { finalStatus, turnIds } = await liveLoop(s, 2, { prompt: userPrompt }, { timeoutMs: 240_000 });

            // Peak assembled context across the loop. Without curation the log
            // accumulates past the wall; staying under means the model HID as it went.
            // packet.tokens is the assembled total (the Packet-sections shape, `{ tokens, sections }`);
            // the old `packet.system.tokens`/`.user.tokens` fields are gone — reading them silently
            // measured 0, making this assertion vacuous until 2026-06-25.
            let peak = 0;
            for (const tid of turnIds) {
                const row = await (s.db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: tid });
                const p = JSON.parse(row?.packet ?? "{}") as { tokens?: number };
                peak = Math.max(peak, p.tokens ?? 0);
            }
            console.error(`[budget-grind] turns=${turnIds.length} finalStatus=${finalStatus} ceiling=${CEILING} peakTotal=${peak}`);

            assert.equal(finalStatus, 200, "model completes the briefing under budget pressure");
            assert.ok(peak <= CEILING, `model kept assembled context under the ${CEILING} ceiling (peaked at ${peak})`);
        } finally { await s.cleanup(); }
    } finally {
        if (prevCeiling === undefined) delete process.env.PLURNK_BUDGET_CEILING;
        else process.env.PLURNK_BUDGET_CEILING = prevCeiling;
        await fixture.cleanup();
    }
});
