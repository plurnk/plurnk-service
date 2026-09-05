import test from "node:test";
import assert from "node:assert/strict";
import { liveLoop, liveWorkspace, pinAliasInputCapacity } from "../_live-harness.ts";
import { measureFloor } from "./_floor-probe.ts";
import { assertOverflowEvidence, seedOverflowFixture } from "./_overflow.ts";

const TIMEOUT = Number(process.env.PLURNK_SERVICE_LIVE_TIMEOUT ?? 600_000);

test("demo: recover from an oversized attached report and retrieve its recovery site", { timeout: TIMEOUT }, async () => {
    const fixture = await seedOverflowFixture();
    try {
        const floor = await measureFloor({ label: "overflow-recovery", projectRoot: fixture.workspace, prompt: fixture.prompt });
        const capacity = Math.round(floor.weight * 1.6);
        const restore = pinAliasInputCapacity({ inputCapacity: capacity, outputBudget: floor.outputBudget });
        try {
            const s = await liveWorkspace({ name: `demo-overflow-recovery-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
            try {
                console.error(`[overflow-recovery] runDir=${s.runDir} floor=${floor.weight} requestedCapacity=${capacity} effectiveCapacity=${s.provider.inputCapacity} outputBudget=${s.provider.outputBudget}`);
                const result = await liveLoop(s, 2, {
                    prompt: fixture.prompt, openPaths: fixture.openPaths, maxTurns: 12,
                }, { timeoutMs: TIMEOUT - 30_000 });
                const evidence = await assertOverflowEvidence({
                    db: s.db, daemon: s.daemon, workspaceId: s.workspaceId,
                    workerId: result.modelWorkerId, turnIds: result.turnIds, fixture,
                });
                console.error(`[overflow-recovery] overflowTurns=${evidence.overflowTurns} modelTurns=${evidence.modelTurns} finalStatus=${result.finalStatus}`);
                assert.equal(result.finalStatus, 200, "the model completes the task after real overflow recovery");
                assert.ok(result.lastContent.includes(fixture.answer), `the model reports the recorded recovery site; got: ${result.lastContent.slice(0, 300)}`);
            } finally { await s.cleanup(); }
        } finally { restore(); }
    } finally { await fixture.cleanup(); }
});
