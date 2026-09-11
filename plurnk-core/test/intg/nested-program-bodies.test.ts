import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_helpers.ts";

for (const header of ["SEND", "EDIT (worker:///example.md)"]) {
    test(`{§fence-boundary}: raw model ${header} preserves examples, original source, and actual task disposition`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `nested-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "Preserve the examples.");
            await seedEntryWithChannel(db, { workspaceId, pathname: "/victim.md", content: "unchanged" });
            const body = [
                "These are examples, not instructions to execute:",
                "````sh", "printf example", "````",
                "````EDIT (worker:///victim.md) <1,-1>", "must not replace the original", "````",
                "````TASK", '[{"content":"Not the real inventory.","status":"failed"}]', "````",
                "Report ends here.",
            ].join("\n");
            const status = header === "SEND" ? "completed" : "in_progress";
            const inventory = [{ content: "Preserve the examples.", status }];
            const source = `\`\`\`\`${header}\n${body}\n\`\`\`\`\n\n${PlurnkParser.frame("TASK", JSON.stringify(inventory))}`;
            const provider = new Mock({
                contextWindow: 100_000,
                responses: [{ assistant: { content: source, reasoning: null }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }],
            });
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "user", content: "Preserve the examples." }] });
            assert.equal(result.status, header === "SEND" ? 200 : 102);
            assert.equal(result.emissionAttempts, 1);
            assert.deepEqual(result.outcomes.map(({ op, status }) => ({ op, status })), [
                { op: header === "SEND" ? "SEND" : "EDIT", status: header === "SEND" ? 200 : 201 },
                { op: "TASK", status: header === "SEND" ? 200 : 102 },
            ]);
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string; rx: string }>({ turn_id: result.turnId });
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
            assert.equal(sources.find(({ turn_id, kind }) => turn_id === result.turnId && kind === "ops")?.content, source);
            const emitted = JSON.parse(rows.find(({ op }) => op === (header === "SEND" ? "SEND" : "EDIT"))!.tx);
            assert.equal(header === "SEND" ? emitted.body.raw : emitted.body, body);
            assert.deepEqual(JSON.parse(rows.find(({ op }) => op === "TASK")!.tx).body, inventory);
            const saved = (pathname: string) => db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname, scheme: "worker", name: "body" });
            assert.equal((await saved("/victim.md"))?.content, "unchanged");
            if (header !== "SEND") assert.equal((await saved("/example.md"))?.content, body);
        } finally { await db.close(); }
    });
}
