import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop, seedEntry } from "../_live-harness.ts";

const TIMEOUT = Number(process.env.PLURNK_SERVICE_LIVE_TIMEOUT ?? 600_000);

test("live: semantic FIND — identify a conceptually related entry without surveying each body", { timeout: TIMEOUT }, async () => {
    const s = await liveWorkspace({ name: `live-semantic-find-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, {
            pathname: "notes/alpha.md",
            content: "A cracked rubber irrigation tube can be repaired with a barbed coupling and two clamps.",
        });
        await seedEntry(s.db, s.workspaceId, {
            pathname: "notes/bravo.md",
            content: "A TLS handshake authenticates peers and negotiates encryption parameters.",
        });
        await seedEntry(s.db, s.workspaceId, {
            pathname: "notes/charlie.md",
            content: "Bread dough develops structure when kneading aligns its gluten network.",
        });
        const { finalStatus, lastContent, modelWorkerId } = await liveLoop(
            s,
            2,
            {
                prompt: "Which entry under worker:///notes/ is conceptually most relevant to mending a leaking garden hose? Use one conceptual lookup rather than opening the entries individually, and report its path.",
            },
            { timeoutMs: TIMEOUT },
        );
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /alpha\.md/i, "the answer identifies the semantically related entry");

        const finds = await s.db.test_log_entries_by_worker_op_full.all<{ tx: string }>({
            worker_id: modelWorkerId,
            op: "FIND",
        });
        assert.ok(finds.some(({ tx }) => {
            const statement = JSON.parse(tx) as { body?: { dialect?: string } | null };
            return statement.body?.dialect === "semantic";
        }), "the model used a semantic matcher rather than surveying entry bodies");
    } finally {
        await s.cleanup();
    }
});
