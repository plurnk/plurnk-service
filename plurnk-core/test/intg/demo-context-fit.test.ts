import { serverProposals } from "./_approval.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { assertContextFitEvidence, seedAttachmentFixture } from "../demo/_context-fit.ts";

test("{§methods-loop-run-open-paths} {§markerless-first-page}: one oversized attachment lands as its first page, cut inside its one long line, and a range READ reaches its answer", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
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
                    prompt: fixture.prompt, openPaths: ["incident.txt"],
                });
                assert.equal(result.finalStatus, 200);
                const turns = await db.test_list_turns_in_loop.all<{ kind: string }>({ loop_id: result.loopId });
                assert.equal(turns.filter(({ kind }) => kind === "overflow").length, 0, "no recovery turn is manufactured");
                const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
                const attachment = rows.find((row) => row.origin === "_plurnk" && row.op === "READ" && row.pathname === "incident.txt");
                assert.ok(attachment);
                assert.equal(attachment.status_rx, 200, "the page is an ordinary result");
                const page = JSON.parse(attachment.rx) as { content: string; region?: { startLine: number; endLine: number; endColumn: number } };
                const chars = Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS);
                assert.equal(page.content.length, chars, "the character bound cuts the one long line");
                assert.equal(content.startsWith(page.content), true, "the page is the head of the line");
                assert.equal(page.region?.startLine, 1);
                assert.equal(page.region?.endLine, 1, "the cut is inside line 1 and says so");
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

for (const retire of [false, true]) test(`{§context-fit}: sixteen attachments land whole until the budget runs out, then as receipts, with the READ rows ${retire ? "retired" : "retained"}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const fixture = await seedAttachmentFixture();
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new Mock({
        contextWindow: 20_000,
        responses: [
            makeMockResponse("````KILL (log:///**/FIND)````\n````READ (incident.txt) <2>````\n````NOTE\nInspect the recovery site.\n````"),
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
                     maxTurns: 6,
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
                const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
                const recovered = rows.filter((row) => row.origin === "model" && row.op === "READ" && row.pathname === "incident.txt");
                assert.equal(recovered.length, 1, "the model made its own recovery READ");
                assert.equal(recovered[0]!.status_rx, 200);
                assert.match(JSON.parse(recovered[0]!.rx).content, new RegExp(fixture.answer, "u"), "the scripted answer is backed by a delivered result");
                assert.equal(provider.remaining, 0);
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previous;
        await fixture.cleanup();
    }
});
