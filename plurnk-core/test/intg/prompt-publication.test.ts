import test from "node:test";
import assert from "node:assert/strict";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import PromptFrames from "../../src/core/PromptFrames.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, makeSchemeCtx } from "./_helpers.ts";

test("{§crud} create-only publication cannot overwrite an existing prompt's bytes or attributes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "prompt-claim");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "original");
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId });
        const pathname = await PromptFrames.write(ctx, { loopSequence: 1, ordinal: 1, content: "original", openPaths: [] });
        const coordinate = { authority: "alice", pathname };
        const before = await EntryCrud.readEntry(coordinate, ctx, "prompt");
        const denied = await EntryCrud.writeEntry(coordinate, {
            channels: { body: { content: "replacement", mimetype: "text/markdown" } },
            attributes: { ordinal: 2 },
        }, ctx, "prompt", { createOnly: true });
        assert.equal(denied.status, 409);
        assert.equal(denied.problem?.type, "https://problems.plurnk.xyz/scheme/prompt/entry-exists");
        assert.deepEqual(await EntryCrud.readEntry(coordinate, ctx, "prompt"), before);
        const repeated = await PromptFrames.write(ctx, { loopSequence: 1, ordinal: 1, pathname, content: "original", openPaths: [] });
        assert.equal(repeated, pathname);
        assert.deepEqual(await db.test_prompt_paths_by_worker.all({ worker_id: workerId }), [{ pathname }]);
    } finally { await db.close(); }
});
