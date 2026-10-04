import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { liveLoop, liveWorkspace, pinAliasInputCapacity } from "../_live-harness.ts";
import { measureFloor } from "./_floor-probe.ts";
import { assertContextFitEvidence, seedAttachmentFixture } from "./_context-fit.ts";


test("demo: attachments beyond the budget land as receipts; the model retrieves the recovery site by range", async (t) => {
    const fixture = await seedAttachmentFixture();
    try {
        const floor = await measureFloor({ signal: t.signal, label: "context-fit", projectRoot: fixture.workspace, prompt: fixture.prompt });
        const capacity = Math.round(floor.weight * 1.6);
        const restore = pinAliasInputCapacity({ inputCapacity: capacity, outputBudget: floor.outputBudget });
        try {
            const s = await liveWorkspace({ name: `demo-context-fit-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
            try {
                console.error(`[context-fit] runDir=${s.runDir} floor=${floor.weight} requestedCapacity=${capacity} effectiveCapacity=${s.provider.inputCapacity} outputBudget=${s.provider.outputBudget}`);
                const result = await liveLoop(s, 2, {
                    prompt: fixture.prompt, openPaths: fixture.openPaths, maxTurns: 12,
                }, { signal: t.signal });
                const evidence = await assertContextFitEvidence({
                    db: s.db, daemon: s.daemon, workspaceId: s.workspaceId,
                    workerId: result.modelWorkerId, turnIds: result.turnIds, fixture,
                });
                console.error(`[context-fit] landed=${evidence.landed} receipts=${evidence.receipts} modelTurns=${evidence.modelTurns} finalStatus=${result.finalStatus}`);
                assert.ok(evidence.receipts > 0, "the pinned capacity left attachments that did not fit: the model saw receipts, not bodies");
                assert.equal(result.finalStatus, 200, "the model completes the task from receipts and range READs");
                assert.ok(result.lastContent.includes(fixture.answer), `the model reports the recorded recovery site; got: ${result.lastContent.slice(0, 300)}`);
            } finally { await s.cleanup(); }
        } finally { restore(); }
    } finally { await fixture.cleanup(); }
});
