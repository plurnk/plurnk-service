// Extreme-budget demo — designed to FAIL until the model is taught to curate.
// The partition CTX is pinned so promptBudget sits just above the fixed sysprompt floor
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

// Pinned above the assembled floor, below the no-curation peak, so the model must read-distill-FOLD
// to stay under rather than the grinder hard-stopping at the floor. The ceiling MUST clear the turn-1
// floor with headroom — a ceiling below the floor asks the impossible (the initial assembly can't fit),
// turning the test into a guaranteed unavoidable-413 rather than a curation probe.
// RECALIBRATED 2026-06-30 against grammar 0.74.39 / schemes 0.32.1: the sysprompt floor grew (the prior
// 3500, set against grammar 0.74.20's ~3102 turn-1, fell ~40t BELOW the new floor — impossible). Measured
// now: the grind task's turn-1 assembles at ~3540t (floor+catalog+first reads); with curation the model
// holds later turns ~3316t; with NO curation the log grows the packet past ~4200t over four turns. 3900
// sits in that window — ~360t of curation headroom over the floor, well below the no-curation runaway.
// Bump again when the sysprompt grows.
const CEILING = 8800; // RAW-ruler units: the effective ceiling divides by the loop calibration ratio (§tokenomics-ceiling-calibrates-to-usage; gemma observes ≤1.4) — 8800/1.4 ≈ 6300 clears the measured 5248 floor + headroom
// The no-curation runaway: where the log accumulates over the loop if the model NEVER folds (~floor
// 3540 + the four-turn log growth, ~683t at this sysprompt → ~4220). The success contract is INTENT,
// not a token-perfect peak: the model can't hit an exact ceiling (one FOLD drops a couple hundred
// tokens at once, so it overshoots/undershoots), and the communicated ceiling is a curation MOTIVATOR,
// not a hard wall. So we assert it COMPLETES under pressure (200, no runaway 413) AND stayed below this
// runaway (it folded as it went) — not that peak landed under the communicated 3900.
const NO_CURATION = 4200;

test("demo: budget grind — under a pinned ceiling, the model must curate to keep assembled context under budget", async () => {
    const fixture = await seedDemoFixture("budget");
    const prevCeiling = process.env.PLURNK_PROVIDERS_CTX;
    // promptBudget = CEILING exactly; a real assistant reserve keeps maxTokens sane for live gemma.
    process.env.PLURNK_PROVIDERS_CTX = String(CEILING + 8192);
    process.env.PLURNK_PROVIDERS_REASONING = "0";
    process.env.PLURNK_PROVIDERS_ASSISTANT = "8192";
    process.env.PLURNK_PROVIDERS_SAFETY = "0"; // captured by the daemon's engine at construction (liveSession, below)
    try {
        const s = await liveSession({ name: `demo-budget-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        try {
            const userPrompt = "Brief me on this project — its codename, the database host it connects to, and the one outstanding TODO in the app code.";
            const { finalStatus, turnIds } = await liveLoop(s, 2, { prompt: userPrompt }, { timeoutMs: 240_000 });

            // Peak assembled context across the loop. packet.tokens is the assembled total (the
            // Packet-sections shape, `{ tokens, sections }`); the old `packet.system.tokens`/`.user.tokens`
            // fields are gone — reading them silently measured 0, making this assertion vacuous until
            // 2026-06-25, then over-strict (peak <= communicated-ceiling) until 2026-06-30.
            let peak = 0;
            for (const tid of turnIds) {
                const row = await (s.db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: tid });
                const p = JSON.parse(row?.packet ?? "{}") as { tokens?: number };
                peak = Math.max(peak, p.tokens ?? 0);
            }
            console.error(`[budget-grind] turns=${turnIds.length} finalStatus=${finalStatus} ceiling=${CEILING} peakTotal=${peak}`);

            assert.equal(finalStatus, 200, "model completes the briefing under budget pressure — no runaway 413");
            assert.ok(peak < NO_CURATION, `the model curated rather than letting the log run away (peaked ${peak}, no-curation ~${NO_CURATION}+; communicated ceiling ${CEILING})`);
        } finally { await s.cleanup(); }
    } finally {
        if (prevCeiling === undefined) delete process.env.PLURNK_PROVIDERS_CTX;
        else process.env.PLURNK_PROVIDERS_CTX = prevCeiling;
        await fixture.cleanup();
    }
});
