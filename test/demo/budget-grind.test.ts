// Extreme-budget demo — designed to FAIL until the model is taught to curate.
// PLURNK_BUDGET_CEILING is pinned just above the fixed sysprompt floor
// (plurnk.md ~1313t + persona/requirements), so a couple of file READs push
// the assembled packet past the wall. With no curation the log accumulates and
// `peak` blows the ceiling; staying under means the model HID earlier reads as
// it worked. The communicated ceiling is shrunk, not the real window, so this
// isolates "does the readout MOTIVATE curation" with no real-413 confound.
// Run + digest (bin/digest.js) to analyze the failure together.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { PrepMethod } from "../../src/core/Db.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import { readFile as readPath } from "node:fs/promises";
import { PATHS } from "../../src/index.ts";
import Yolo from "../../src/server/yolo.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";
import { seedDemoFixture } from "./_fixture.ts";

const makeMimetypes = async (provider: Provider): Promise<Mimetypes> => {
    const m = new Mimetypes({ tokenize: async (text) => provider.countTokens(text) });
    await m.ready();
    return m;
};

const SYSTEM_PROMPT = await readPath(PATHS.instructionsSystem, "utf8");

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) throw new Error("PLURNK_MODEL not set; demo tests require a configured model alias");
    const provider = await ProviderInstantiate.loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null");
    return provider;
};

// Pinned above the assembled floor+catalog — measured as the turn-1 peak, which
// grew to ~1816 with grammar 0.20.0 + mimetypes 0.10.0's larger sysprompt (was
// ~1478) — and below the with-reads peak, so the model must read-distill-HIDE to
// answer rather than the grinder hard-stopping at the floor. Bump when the
// sysprompt grows again. Absolute mode (>1) holds though gemma reports no window.
const CEILING = 2000;

test("demo: budget grind — under a pinned ceiling, the model must curate to keep assembled context under budget", async () => {
    const fixture = await seedDemoFixture("budget");
    const provider = await buildProvider();
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        process.env.PLURNK_BUDGET_CEILING = String(CEILING);
        const engine = new Engine({ db, schemes, mimetypes: await makeMimetypes(provider) });
        delete process.env.PLURNK_BUDGET_CEILING; // engine captured it at construction
        Yolo.attachYolo(engine, db);
        const sessionId = await insertSession(db, `demo-budget-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: sessionId, project_root: fixture.workspace });
        await fixture.addToCatalog(db, sessionId);
        const runId = await insertRun(db, sessionId);
        const userPrompt = "Brief me on this project — its codename, the database host it connects to, and the one outstanding TODO in the app code.";
        const loopId = await insertLoop(db, runId, 1, userPrompt);
        await (db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify({ yolo: true }) });

        const result = await engine.runLoop({
            provider, sessionId, runId, loopId,
            messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }],
        });
        await exec.idle();

        // Peak assembled context across the loop. Without curation the log
        // accumulates past the wall; staying under means the model HID as it went.
        let peak = 0;
        for (const tid of result.turnIds) {
            const row = await (db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: tid });
            const p = JSON.parse(row?.packet ?? "{}") as { system?: { tokens?: number }; user?: { tokens?: number } };
            peak = Math.max(peak, (p.system?.tokens ?? 0) + (p.user?.tokens ?? 0));
        }
        console.error(`[budget-grind] turns=${result.turnIds.length} finalStatus=${result.finalStatus} ceiling=${CEILING} peakTotal=${peak}`);

        assert.equal(result.finalStatus, 200, "model completes the briefing under budget pressure");
        assert.ok(peak <= CEILING, `model kept assembled context under the ${CEILING} ceiling (peaked at ${peak})`);
    } finally {
        await fixture.cleanup();
        await db.close();
    }
});
