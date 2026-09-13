// {§exec-stream} — a READ of a stream channel says whether the stream has concluded, so an empty
// page on a live command is never mistaken for a finished command that printed nothing.
import assert from "node:assert/strict";
import test from "node:test";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { DEFAULT_MIMETYPES, openMigrated, seedEntryWithChannel, seedEnvelope, testExecutors } from "./_helpers.ts";
import { readStmt, urlPath } from "./_dsl.ts";

test("{§exec-stream}: a stream READ carries terminal: false while the command runs and terminal: true once it concluded", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, turnId } = await seedEnvelope(db, `stream-liveness-${crypto.randomUUID()}`, { producer: "client" });
        const seed = async (pathname: string, content: string, close: boolean): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname, channel: "stdout", content, mimetype: "text/stream" });
            const subscriptionId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sh", handle: `sh: ${pathname}` });
            if (close) await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });
        };
        await seed("/1/1/1/sh", "", false);
        await seed("/1/1/2/sh", "all done\n", true);
        const schemes = new SchemeRegistry();
        const executors = await testExecutors();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        let sequence = 0;
        const read = (pathname: string) => engine.dispatch({ statement: readStmt(urlPath("sh", pathname), { marks: [1, -1] }), workspaceId, workerId, loopId, turnId, sequence: ++sequence, origin: "client" });
        const live = await read("/1/1/1/sh");
        assert.equal(live.status, 204, JSON.stringify(live));
        assert.equal(live.terminal, false, "an empty page on a live stream says the stream is still running");
        const done = await read("/1/1/2/sh");
        assert.equal(done.status, 200, JSON.stringify(done));
        assert.equal(done.terminal, true, "a concluded stream says so on every READ");
        assert.equal(done.content, "all done");
    } finally { await db.close(); }
});
