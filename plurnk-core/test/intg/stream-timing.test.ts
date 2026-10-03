import assert from "node:assert/strict";
import test from "node:test";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Engine from "../../src/core/Engine.ts";
import DbChannelCaps from "../../src/core/caps/DbChannelCaps.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { provider } from "./reasoning-fixture.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { testExecutors } from "./_execs.ts";
import { readStmt, urlPath } from "./_dsl.ts";

test("{§child-orientation}: a quiet stream's packet reports elapsed runtime and output inactivity", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "stream-timing");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId, scheme: "sh", authority: "", pathname: "/1234abcd",
            channel: "stdout", content: "", mimetype: "text/stream", state: "active",
        });
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            workerId, entryId, scheme: "sh", handle: "quiet-command",
        });
        const row = await db.test_stream_opened_at.get<{ opened_at: string }>({ id: subscriptionId });
        assert.ok(row);
        t.mock.method(Date, "now", () => Date.parse(row.opened_at) + 125_500);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const build = () => packets.buildRequestPacket({
            initialMessages: [], workspaceId, workerId, loopId, currentTurnSeq: 1,
            provider: provider(), gitStatus: null,
        });
        const first = await build();
        assert.deepEqual(JSON.parse(first.sections.find(({ name }) => name === "delegation")!.content), {
            workers: [],
            streams: [{
                status: "active", path: "sh:///1234abcd",
                detail: "elapsed 125s; output unchanged 125s; stdout 0 lines (+0 bytes)",
            }],
        });
        await packets.recordObservations(first);
        const second = await build();
        assert.equal(second.sections.find(({ name }) => name === "delegation")!.content,
            first.sections.find(({ name }) => name === "delegation")!.content,
            "observing an empty stream does not reset its inactivity");
        await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });
        const terminal = await build();
        assert.deepEqual(JSON.parse(terminal.sections.find(({ name }) => name === "delegation")!.content),
            { workers: [], streams: [] }, "closed streams leave the active inventory");
    } finally { await db.close(); }
});

test("{§child-orientation}: only changes to published output reset the durable stream clock", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "stream-clock-writes");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const pathname = "/abcd1234";
        const entryId = await seedEntryWithChannel(db, {
            workspaceId, scheme: "sh", authority: "", pathname,
            channel: "stdout", content: "alpha", mimetype: "text/stream", state: "active",
        });
        for (const name of ["stderr", "internal"]) await db.test_seed_channel.run({
            entry_id: entryId, name, content: "", mimetype: "text/stream", state: "active",
        });
        let subscriptionId = await ChannelWrite.openSubscription(db, {
            workerId, entryId, scheme: "sh", handle: "fixture", publishedChannel: "stdout",
        });
        const channels = new DbChannelCaps(makeSchemeCtx({ db, workspaceId, workerId }), "sh", "");
        const executors = await testExecutors();
        const schemes = new SchemeRegistry();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        const original = "2026-01-01T00:00:00.000Z";
        const clock = () => db.test_stream_clock.get<{ opened_at: string; output_changed_at: string | null }>({ id: subscriptionId });
        const rebase = () => db.test_stream_set_clock.run({
            id: subscriptionId, opened_at: original, output_changed_at: original,
        });
        for (const specimen of [
            { name: "unpublished stderr", changed: false, write: () => channels.append(pathname, "stderr", "hidden") },
            { name: "mimetype", changed: false, write: () => db.set_channel_mimetype.run({ entry_id: entryId, channel: "stdout", mimetype: "text/plain" }) },
            { name: "state closure", changed: false, write: () => channels.setState(pathname, "stdout", "closed") },
            { name: "state reopening", changed: false, write: () => channels.setState(pathname, "stdout", "active") },
            { name: "empty append", changed: false, write: () => channels.append(pathname, "stdout", "") },
            { name: "identical replacement", changed: false, write: () => channels.replace(pathname, "stdout", "alpha") },
            { name: "equal-sized replacement", changed: true, write: () => channels.replace(pathname, "stdout", "bravo") },
            { name: "clearing content", changed: true, write: () => channels.replace(pathname, "stdout", "") },
            { name: "empty-to-empty replacement", changed: false, write: () => channels.replace(pathname, "stdout", "") },
            { name: "executor append", changed: true, write: () => ChannelWrite.appendToChannel(db, { entryId, producerWorkerId: workerId, channel: "stdout", chunk: "visible\n" }) },
            { name: "ordinary stream READ", changed: false, write: () => engine.look({ workspaceId, workerId, loopId, statement: readStmt(urlPath("sh", pathname, "stdout"), { marks: [1, -1] }) }) },
        ]) await t.test(specimen.name, async () => {
            await rebase();
            const result = await specimen.write();
            if (result !== undefined && "status" in result) assert.equal(result.status, 200, specimen.name);
            const after = await clock();
            assert.equal(after?.opened_at, original, "activity never restarts elapsed runtime");
            if (specimen.changed) assert.ok(after?.output_changed_at !== null && after!.output_changed_at! > original,
                `${specimen.name} advances the output clock`);
            else assert.equal(after?.output_changed_at, original, `${specimen.name} is not output activity`);
        });

        await rebase();
        await assert.rejects(db.replace_channel_content.all({
            entry_id: entryId, channel: "stdout", content: "rejected", weight: -1,
        }), /CHECK constraint failed/u);
        assert.equal((await clock())?.output_changed_at, original, "a rejected content write cannot advance the clock");
        assert.equal((await db.test_get_channel.get<{ content: string }>({ entry_id: entryId, name: "stdout" }))?.content,
            "visible\n", "content and the clock roll back together");

        await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });
        await channels.append(pathname, "stdout", "after close");
        assert.equal((await clock())?.output_changed_at, original, "a closed subscription's clock is settled");
        subscriptionId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sh", handle: "all-channels" });
        await rebase();
        await channels.append(pathname, "stderr", "published\n");
        assert.ok((await clock())!.output_changed_at! > original, "another published channel also resets the one stream clock");
    } finally { await db.close(); }
});

test("{§child-orientation}: packet durations advance independently, clamp clock rollback, and retain unknown evidence", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "stream-clock-packets");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId, scheme: "sh", authority: "", pathname: "/1234abcd",
            channel: "stdout", content: "ready\n", mimetype: "text/stream", state: "active",
        });
        await db.test_seed_channel.run({ entry_id: entryId, name: "stderr", content: "", mimetype: "text/stream", state: "active" });
        const subscriptionId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sh", handle: "fixture" });
        const openedAt = "2026-01-01T00:00:00.000Z";
        const changedAt = "2026-01-01T00:01:40.000Z";
        await db.test_stream_set_clock.run({ id: subscriptionId, opened_at: openedAt, output_changed_at: changedAt });
        let now = Date.parse(openedAt) + 300_900;
        t.mock.method(Date, "now", () => now);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const build = () => packets.buildRequestPacket({
            initialMessages: [], workspaceId, workerId, loopId, currentTurnSeq: 1, provider: provider(), gitStatus: null,
        });
        const first = await build();
        assert.equal(JSON.parse(first.sections.find(({ name }) => name === "delegation")!.content).streams[0].detail,
            "elapsed 300s; output unchanged 200s; stderr 0 lines (+0 bytes); stdout 1 lines (+6 bytes)");
        await packets.recordObservations(first);
        now += 20_000;
        const next = await build();
        assert.equal(JSON.parse(next.sections.find(({ name }) => name === "delegation")!.content).streams[0].detail,
            "elapsed 320s; output unchanged 220s; stderr 0 lines (+0 bytes); stdout 1 lines (+0 bytes)");
        assert.equal(next.sections.find(({ name }) => name === "log")!.content, first.sections.find(({ name }) => name === "log")!.content,
            "volatile timing stays in the status footer, not the cacheable log prefix");
        now = Date.parse(openedAt) - 1_000;
        const backwards = await build();
        assert.match(JSON.parse(backwards.sections.find(({ name }) => name === "delegation")!.content).streams[0].detail,
            /^elapsed 0s; output unchanged 0s;/u);
        await db.test_stream_set_clock.run({ id: subscriptionId, opened_at: openedAt, output_changed_at: null });
        const unknown = await build();
        assert.match(JSON.parse(unknown.sections.find(({ name }) => name === "delegation")!.content).streams[0].detail,
            /^elapsed 0s; output timing unknown;/u);
    } finally { await db.close(); }
});
