// Tests for daemon's stream/event notification. SPEC {§live-updates} + {§notifications}.

import test from "node:test";
import assert from "node:assert/strict";
import ChannelWrite, { type StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import { seedEntryWithChannel } from "./_db.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon } from "./_rpc.ts";
test("{§live-updates} notifyStreamEvent broadcasts to a workspace's clients, envelope stamped with the scope", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "stream-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");

            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "hello", state: "active" });
            const sessionId = await RuntimeSession.ensure(db, workspaceId);
            daemon.notifyStreamEvent(workspaceId, {
                entryId, sessionId, target: "workspace:///x", channel: "body", state: "active", contentLength: 5, mimetype: "text/markdown",
            });

            assert.equal(captured().length, 1);
            const evt = captured()[0] as { workspaceId: number; entryId: number; sessionId: number; channel: string; state: string; contentLength: number };
            assert.equal(evt.workspaceId, workspaceId, "the envelope carries its workspace scope so multi-workspace clients can route it");
            assert.equal(evt.entryId, entryId);
            assert.equal(evt.sessionId, sessionId);
            assert.equal(evt.channel, "body");
            assert.equal(evt.state, "active");
            assert.equal(evt.contentLength, 5);
        } finally { ws.close(); }
    });
});

test("{§live-updates} appendToChannel via the daemon's notify callback fires stream/event end-to-end", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "append-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "hi", state: "active" });

            const notify = (sid: number, ev: StreamEventPayload) =>
                daemon.notifyStreamEvent(sid, ev);
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "!", notify });
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "?", notify });

            const events = captured() as Array<{ contentLength: number; target: string }>;
            assert.equal(events.length, 2);
            assert.equal(events[0].contentLength, 3);
            assert.equal(events[1].contentLength, 4);
            assert.equal(events[0].target, "workspace:///x", "stream/event carries the entry's canonical target URI");
        } finally { ws.close(); }
    });
});

test("{§live-updates} setChannelState end-to-end fires stream/event with state change", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "state-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "done", state: "active" });

            await ChannelWrite.setChannelState(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", state: "closed", notify: (sid, ev) => daemon.notifyStreamEvent(sid, ev) });

            const events = captured() as Array<{ state: string }>;
            assert.equal(events.length, 1);
            assert.equal(events[0].state, "closed");
        } finally { ws.close(); }
    });
});

test("{§live-updates} stream/event is workspace-scoped — other workspaces don't see it", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aResp = await rpcCall(wsA, 1, "workspace.create", { name: "workspace-A" });
            const bResp = await rpcCall(wsB, 1, "workspace.create", { name: "workspace-B" });
            const workspaceA = (aResp.result as { id: number }).id;
            const workspaceB = (bResp.result as { id: number }).id;

            const aEvents = subscribeNotifications(wsA, "stream/event");
            const bEvents = subscribeNotifications(wsB, "stream/event");

            const entryIdA = await seedEntryWithChannel(db, { workspaceId: workspaceA, content: "hi", state: "active" });
            const sessionIdA = await RuntimeSession.ensure(db, workspaceA);
            daemon.notifyStreamEvent(workspaceA, {
                entryId: entryIdA, sessionId: sessionIdA, target: "workspace:///x", channel: "body", state: "active", contentLength: 2, mimetype: "text/markdown",
            });

            const entryIdB = await seedEntryWithChannel(db, { workspaceId: workspaceB, content: "yo", state: "active" });
            const sessionIdB = await RuntimeSession.ensure(db, workspaceB);
            daemon.notifyStreamEvent(workspaceB, {
                entryId: entryIdB, sessionId: sessionIdB, target: "workspace:///x", channel: "body", state: "active", contentLength: 2, mimetype: "text/markdown",
            });


            const aCaptured = aEvents() as Array<{ entryId: number }>;
            assert.equal(aCaptured.length, 1);
            assert.equal(aCaptured[0].entryId, entryIdA);

            const bCaptured = bEvents() as Array<{ entryId: number }>;
            assert.equal(bCaptured.length, 1);
            assert.equal(bCaptured[0].entryId, entryIdB);
        } finally { wsA.close(); wsB.close(); }
    });
});

test("{§live-updates} appendToChannel + setChannelState forward the entry coordinate onto stream/event", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "coord-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "hi", state: "active" });

            const notify = (sid: number, ev: StreamEventPayload) =>
                daemon.notifyStreamEvent(sid, ev);
            const coordinate = { loop_seq: 1, turn_seq: 2, sequence: 3 };
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "!", notify, coordinate });
            await ChannelWrite.setChannelState(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", state: "closed", notify, coordinate });

            const events = captured() as Array<{ loop_seq?: number; turn_seq?: number; sequence?: number }>;
            assert.equal(events.length, 2);
            for (const ev of events) {
                assert.equal(ev.loop_seq, 1, "stream/event carries the coordinate as fields, not buried in the URI");
                assert.equal(ev.turn_seq, 2);
                assert.equal(ev.sequence, 3);
            }
        } finally { ws.close(); }
    });
});

test("{§live-updates} appendToChannel with a mimetype retypes the channel + surfaces it on stream/event", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "retype-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            // Seeded text/markdown (the manifest default); a streaming scheme learns the real type per call.
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "", mimetype: "text/markdown", state: "active" });

            const notify = (sid: number, ev: StreamEventPayload) =>
                daemon.notifyStreamEvent(sid, ev);
            // First chunk carries the now-known per-call type → retype.
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "{", notify, mimetype: "application/json" });
            // A later chunk omits it — the retype must persist (stored, not per-event).
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "}", notify });

            const events = captured() as Array<{ mimetype?: string }>;
            assert.equal(events.length, 2);
            assert.equal(events[0].mimetype, "application/json", "the labelled chunk retypes the channel away from text/markdown + carries it");
            assert.equal(events[1].mimetype, "application/json", "the retype is stored — a later unlabelled chunk still reports it");
        } finally { ws.close(); }
    });
});
