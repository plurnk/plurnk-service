import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { assertOverflowEvidence, seedOverflowFixture } from "../demo/_overflow.ts";

for (const retire of [false, true]) test(`the recovery demo preserves overflow evidence with the attachment receipt ${retire ? "retired" : "active"}`, async () => {
    const fixture = await seedOverflowFixture();
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new Mock({
        contextWindow: 20_000,
        responses: [
            makeMockResponse("### READ0 (incident.txt) <2>\n### SEND0 (NEXT)\nInspect the recovery site."),
            makeMockResponse(`${retire ? "### KILL0 (log:///**/READ)\n" : ""}### SEND0 (TERM)\n${fixture.answer}`),
        ],
    });
    try {
        await withDaemon(provider, async (db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const created = await rpcCall(ws, 1, "workspace.create", { name: "overflow-demo", projectRoot: fixture.workspace });
                assert.equal(created.error, undefined);
                const workspaceId = (created.result as { id: number }).id;
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: fixture.prompt, openPaths: fixture.openPaths,
                    policy: { proposals: "accept" }, maxTurns: 6,
                }, { timeoutMs: 20_000 });
                assert.equal(result.finalStatus, 200);
                assert.ok(result.modelWorkerId);
                const evidence = await assertOverflowEvidence({
                    db, daemon, workspaceId, workerId: result.modelWorkerId,
                    turnIds: result.turnIds ?? [], fixture,
                });
                assert.equal(evidence.overflowTurns, 1);
                assert.equal(evidence.modelTurns, 2, "overflow does not consume a scripted model response");
                assert.equal(evidence.receiptActive, !retire);
                assert.equal(provider.remaining, 0);
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previous;
        await fixture.cleanup();
    }
});
