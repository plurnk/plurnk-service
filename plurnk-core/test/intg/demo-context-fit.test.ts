import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { RESULT_EXCEEDS_BUDGET } from "../../src/core/ContextFit.ts";
import { assertContextFitEvidence, seedAttachmentFixture } from "../demo/_context-fit.ts";

test("{§methods-loop-run-open-paths} {§context-fit}: one oversized attachment is a bodiless receipt, and a range READ reaches its answer", async () => {
    const fixture = await seedAttachmentFixture();
    const content = `Telemetry: ${"sample nominal; ".repeat(12_000)}\nRecovery site: ${fixture.answer}.\n`;
    const provider = new Mock({ contextWindow: 20_000, responses: [
        makeMockResponse("````READ (incident.txt) <2>````\n````NOTE\nInspect the recovery site.\n````"),
        makeMockResponse(`\`\`\`\`KILL
${fixture.answer}
\`\`\`\``),
    ] });
    try {
        await writeFile(join(fixture.workspace, "incident.txt"), content);
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "oversized-attachment", projectRoot: fixture.workspace });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: fixture.prompt, openPaths: ["incident.txt"], policy: { proposals: "accept" },
                });
                assert.equal(result.finalStatus, 200);
                const turns = await db.test_list_turns_in_loop.all<{ kind: string }>({ loop_id: result.loopId });
                assert.equal(turns.filter(({ kind }) => kind === "overflow").length, 0, "no recovery turn is manufactured");
                const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
                const attachment = rows.find((row) => row.origin === "_plurnk" && row.op === "READ" && row.pathname === "incident.txt");
                assert.ok(attachment);
                assert.equal(attachment.status_rx, 413, "the attachment did not fit");
                const receipt = JSON.parse(attachment.rx) as { content: string | null; problem: { type: string; lines: number; tokens: number; remaining: number } };
                assert.equal(receipt.content, null, "a receipt carries no body: not a head, not a page");
                assert.equal(receipt.problem.type, RESULT_EXCEEDS_BUDGET);
                assert.equal(receipt.problem.lines, 2, "the size is stated in lines");
                assert.ok(receipt.problem.tokens > receipt.problem.remaining);
                const answer = rows.find((row) => row.origin === "model" && row.op === "READ" && row.pathname === "incident.txt");
                assert.ok(answer, "the model's own range READ ran");
                assert.equal(answer.status_rx, 200);
                assert.match((JSON.parse(answer.rx) as { content: string }).content, new RegExp(fixture.answer, "u"), "a range of the same file fits and answers");
                assert.equal(await readFile(join(fixture.workspace, "incident.txt"), "utf8"), content);
                assert.equal(provider.remaining, 0);
            } finally { ws.close(); }
        });
    } finally { await fixture.cleanup(); }
});

for (const retire of [false, true]) test(`{§context-fit}: sixteen attachments land whole until the budget runs out, then as receipts, with the READ rows ${retire ? "retired" : "retained"}`, async () => {
    const fixture = await seedAttachmentFixture();
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new Mock({
        contextWindow: 20_000,
        responses: [
            makeMockResponse("````READ (incident.txt) <2>````\n````NOTE\nInspect the recovery site.\n````"),
            makeMockResponse(`${retire ? "````KILL (log:///**/READ)````\n" : ""}\`\`\`\`KILL
${fixture.answer}
\`\`\`\``),
        ],
    });
    try {
        await withDaemon(provider, async (db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const created = await rpcCall(ws, 1, "workspace.create", { name: "attachments-fit", projectRoot: fixture.workspace });
                assert.equal(created.error, undefined);
                const workspaceId = (created.result as { id: number }).id;
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: fixture.prompt, openPaths: fixture.openPaths,
                    policy: { proposals: "accept" }, maxTurns: 6,
                }, { timeoutMs: 20_000 });
                assert.equal(result.finalStatus, 200);
                assert.ok(result.modelWorkerId);
                const evidence = await assertContextFitEvidence({
                    db, daemon, workspaceId, workerId: result.modelWorkerId,
                    turnIds: result.turnIds ?? [], fixture,
                });
                assert.ok(evidence.landed > 0, "the first attachments fit and landed whole");
                assert.ok(evidence.receipts > 0, "the budget ran out: the rest are receipts");
                assert.equal(evidence.modelTurns, 2, "receipts cost no turn; the model answered in two");
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
