import assert from "node:assert/strict";
import test from "node:test";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_helpers.ts";
import { provider } from "./reasoning-fixture.ts";

test("{§reasoning-initial-read}: packet preflight preserves stream growth until an actual provider request", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-preflight");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const schemes = new SchemeRegistry();
        const entryId = await seedEntryWithChannel(db, {
            workspaceId, ownerId: workerId, scheme: "worker", pathname: "/progress",
            channel: "stdout", content: "running\n", mimetype: "text/stream", state: "active",
        });
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            workerId, entryId, scheme: "worker", handle: "fixture", publishedChannel: "stdout",
        });
        const model = provider();
        const packets = new PacketBuilder({ db, schemes, executors: () => undefined });
        const build = () => packets.buildRequestPacket({
            initialMessages: [], workspaceId, workerId, loopId, currentTurnSeq: 1, provider: model, gitStatus: null,
        });
        const cursor = async () => (await db.test_subscription_publications.all<{ published_end: number }>({ id: subscriptionId }))[0]!.published_end;
        const first = await build();
        const second = await build();
        assert.equal(await cursor(), 0);
        assert.deepEqual(first.sections, second.sections, "measuring the candidate cannot consume the stream's growth pointer");
        assert.match(second.sections.find(({ name }) => name === "child-streams")!.content, /\(\+8 bytes\)/);
        const attributed = { ...second, attributions: [] };
        assert.equal(packets.curationOverflow(attributed, model), null, "ordinary attribution copies preserve measured admission identity");
        await packets.recordObservations(attributed);
        assert.equal(await cursor(), 8);
        await ChannelWrite.appendToChannel(db, { entryId, channel: "stdout", chunk: "more\n" });
        const newer = await build();
        assert.equal(await cursor(), 8);
        assert.match(newer.sections.find(({ name }) => name === "child-streams")!.content, /\(\+5 bytes\)/);
        const engine = new Engine({ db, schemes });
        await engine.runTurn({ workspaceId, workerId, loopId, provider: model, messages: [] });
        assert.equal(await cursor(), 13, "the composed provider path acknowledges the actual request");
        await packets.recordObservations(first);
        assert.equal(await cursor(), 13, "acknowledging an earlier snapshot never rewinds the cursor");
    } finally { await db.close(); }
});
