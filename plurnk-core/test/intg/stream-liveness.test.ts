// {§exec-stream} — a READ of a stream channel says whether the stream has concluded, so an empty
// page on a live command is never mistaken for a finished command that printed nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { DEFAULT_MIMETYPES, logEntries, openMigrated, seedEntryWithChannel, seedEnvelope, testExecutors } from "./_helpers.ts";
import { readStmt, urlPath } from "./_dsl.ts";

test("{§exec-stream}: a stream READ carries terminal: false while the command runs and terminal: true once it concluded", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, turnId } = await seedEnvelope(db, `stream-liveness-${crypto.randomUUID()}`, { producer: "client" });
        const seed = async (pathname: string, content: string, close: boolean): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname, channel: "stdout", content, mimetype: "text/stream", state: "active" });
            const subscriptionId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sh", handle: `sh: ${pathname}` });
            if (close) await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200, exitCode: 0 } });
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
        const packets = new PacketBuilder({ db, schemes, executors: () => executors });
        const packet = await packets.buildRequestPacket({
            workspaceId, workerId, loopId, currentTurnSeq: 2,
            provider: new Mock({ contextWindow: 100_000, responses: [] }),
            initialMessages: [], gitStatus: null,
        });
        const rows = logEntries(packet);
        const liveRow = rows.find((row) => row.path === "sh:///1/1/1/sh");
        const doneRow = rows.find((row) => row.path === "sh:///1/1/2/sh");
        assert.ok(liveRow, "the dispatched live READ reaches the assembled packet");
        assert.ok(doneRow, "the dispatched completed READ reaches the assembled packet");
        assert.equal(liveRow.terminal, false, "the packet preserves the empty stream's active state");
        assert.equal(liveRow.exitCode, undefined, "an active stream has no invented exit code");
        assert.equal(doneRow.terminal, true, "the packet preserves the completed stream's state");
        assert.equal(doneRow.exitCode, 0, "the packet preserves the completed stream's exact exit code");
    } finally { await db.close(); }
});
