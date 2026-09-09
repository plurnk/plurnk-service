import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { assertOverflowEvidence, seedOverflowFixture } from "../demo/_overflow.ts";

test("{§methods-loop-run-open-paths}: one oversized attachment is previewed without forcing overflow", async () => {
    const fixture = await seedOverflowFixture();
    const content = `Telemetry: ${"sample nominal; ".repeat(12_000)}\nRecovery site: ${fixture.answer}.\n`;
    const provider = new Mock({ contextWindow: 20_000, responses: [
        makeMockResponse("```READ (incident.txt) <2>```\n```TASK\n[{\"content\":\"Inspect the recovery site.\",\"status\":\"in_progress\"}]\n```"),
        makeMockResponse(`\`\`\`SEND
${fixture.answer}
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\``),
    ] });
    try {
        await writeFile(join(fixture.workspace, "incident.txt"), content);
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "bounded-attachment", projectRoot: fixture.workspace });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: fixture.prompt, openPaths: ["incident.txt"], policy: { proposals: "accept" },
                });
                assert.equal(result.finalStatus, 200);
                const turns = await db.test_list_turns_in_loop.all<{ kind: string }>({ loop_id: result.loopId });
                assert.equal(turns.filter(({ kind }) => kind === "overflow").length, 0);
                const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string; pathname: string; rx: string }>({ loop_id: result.loopId });
                const attachment = rows.find((row) => row.origin === "_plurnk" && row.op === "READ" && row.pathname === "incident.txt");
                assert.ok(attachment);
                const preview = JSON.parse(attachment.rx);
                assert.equal(preview.content, content.slice(0, 2560));
                assert.deepEqual(preview.region, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2561 });
                assert.equal(await readFile(join(fixture.workspace, "incident.txt"), "utf8"), content);
                assert.equal(provider.remaining, 0);
            } finally { ws.close(); }
        });
    } finally { await fixture.cleanup(); }
});

for (const retire of [false, true]) test(`the recovery demo preserves overflow evidence with the attachment receipt ${retire ? "retired" : "active"}`, async () => {
    const fixture = await seedOverflowFixture();
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new Mock({
        contextWindow: 20_000,
        responses: [
            makeMockResponse("```READ (incident.txt) <2>```\n```TASK\n[{\"content\":\"Inspect the recovery site.\",\"status\":\"in_progress\"}]\n```"),
            makeMockResponse(`${retire ? "```KILL (log:///**/READ)```\n" : ""}\`\`\`SEND
${fixture.answer}
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\``),
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
