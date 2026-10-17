import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { makeRawMockResponse } from "./_mock.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";

for (const shape of ["separate", "glob", "final"] as const) {
    test(`{§op-execution-order}: cancellation after the first ${shape} mutation retains it and stops the program`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, `cancel-${shape}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "edit the entries");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const entries = await Promise.all(["/a.txt", "/b.txt"].map((pathname) =>
            seedEntryWithChannel(db, { workspaceId, pathname, content: "original" })));
        const paths = shape === "glob" ? ["worker:///*.txt"]
            : shape === "separate" ? ["worker:///a.txt", "worker:///b.txt"] : ["worker:///a.txt"];
        const source = paths.map((path) => PlurnkParser.frame(`EDIT (${path}) <1,-1>`, "changed")).join("\n\n");
        const provider = new Mock({ contextWindow: 100_000, responses: [makeRawMockResponse(source, 37)] });
        const abort = new AbortController();
        const reason = new Error("cancel after the first committed effect");
        t.after(engine.bindLoopSignal(loopId, abort.signal));
        let cancelledAt: number | undefined;
        await assert.rejects(engine.runTurn({
            provider, workspaceId, workerId, loopId, signal: abort.signal,
            messages: [{ role: "user", content: "Edit the entries." }],
            onSettled: async (id) => {
                const rows = await db.test_log_entries_by_worker.all<{ id: number; origin: string; op: string }>({ worker_id: workerId });
                if (cancelledAt === undefined && rows.some((row) => row.id === id && row.origin === "model" && row.op === "EDIT")) {
                    cancelledAt = id;
                    abort.abort(reason);
                }
            },
        }), (cause) => cause === reason);
        assert.ok(cancelledAt !== undefined, "the first real effect settled before cancellation");
        const content = await Promise.all(entries.map(async (entryId) =>
            (await db.test_get_channel.get<{ content: string }>({ entry_id: entryId, name: "body" }))?.content));
        assert.deepEqual(content, ["changed", "original"], "cancellation preserves the committed effect and never applies the next one");
        const rows = await db.test_log_entries_by_worker.all<{ id: number; origin: string; op: string; status_rx: number }>({ worker_id: workerId });
        assert.deepEqual(rows.filter((row) => row.origin === "model" && row.op === "EDIT").map(({ id, status_rx }) => [id, status_rx]), [[cancelledAt, 200]]);
        const turns = await db.test_list_turns_in_loop.all<{ kind: string; status: number; completed_at: string | null }>({ loop_id: loopId });
        const inference = turns.find(({ kind }) => kind === "inference");
        assert.equal(inference?.status, 499);
        assert.ok(inference?.completed_at);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: workerId });
        assert.ok(sources.some(({ kind, content }) => kind === "ops" && content === source), "the complete authored program remains evidence");
        assert.equal((await engine.loopUsage(loopId)).accounting.usage?.outputTokens, 37, "cancellation does not discard completed inference accounting");
    });
}
