// Tests for daemon's stream/event notification. SPEC §live-updates + §notifications.

import test from "node:test";
import assert from "node:assert/strict";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { seedEntryWithChannel } from "./_helpers.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";
test("[§notifications-envelope-carries-sessionid] notifyStreamEvent broadcasts to a session's clients, envelope stamped with the scope", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionResp = await rpcCall(ws, 1, "session.create", { name: "stream-test" });
            const sessionId = (sessionResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");

            const entryId = await seedEntryWithChannel(db, { sessionId, content: "hello", state: "active" });
            daemon.notifyStreamEvent(sessionId, { entryId, channel: "body", state: "active", contentLength: 5 });
            await flush();

            assert.equal(captured().length, 1);
            const evt = captured()[0] as { sessionId: number; entryId: number; channel: string; state: string; contentLength: number };
            assert.equal(evt.sessionId, sessionId, "the envelope carries its session scope so multi-session clients can route it (#191)");
            assert.equal(evt.entryId, entryId);
            assert.equal(evt.channel, "body");
            assert.equal(evt.state, "active");
            assert.equal(evt.contentLength, 5);
        } finally { ws.close(); }
    });
});

test("appendToChannel via the daemon's notify callback fires stream/event end-to-end", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionResp = await rpcCall(ws, 1, "session.create", { name: "append-test" });
            const sessionId = (sessionResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { sessionId, content: "hi", state: "active" });

            const notify = (sid: number, ev: { entryId: number; channel: string; state: string; contentLength: number }) =>
                daemon.notifyStreamEvent(sid, ev);
            await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "!", notify });
            await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "?", notify });
            await flush();

            const events = captured() as Array<{ contentLength: number; target: string }>;
            assert.equal(events.length, 2);
            assert.equal(events[0].contentLength, 3);
            assert.equal(events[1].contentLength, 4);
            assert.equal(events[0].target, "known:///x", "stream/event carries the entry's target URI (#179)");
        } finally { ws.close(); }
    });
});

test("setChannelState end-to-end fires stream/event with state change", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionResp = await rpcCall(ws, 1, "session.create", { name: "state-test" });
            const sessionId = (sessionResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { sessionId, content: "done", state: "active" });

            await ChannelWrite.setChannelState(db, { entryId, channel: "body", state: "closed", notify: (sid, ev) => daemon.notifyStreamEvent(sid, ev) });
            await flush();

            const events = captured() as Array<{ state: string }>;
            assert.equal(events.length, 1);
            assert.equal(events[0].state, "closed");
        } finally { ws.close(); }
    });
});

test("stream/event is session-scoped — other sessions don't see it", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aResp = await rpcCall(wsA, 1, "session.create", { name: "session-A" });
            const bResp = await rpcCall(wsB, 1, "session.create", { name: "session-B" });
            const sessionA = (aResp.result as { id: number }).id;
            const sessionB = (bResp.result as { id: number }).id;

            const aEvents = subscribeNotifications(wsA, "stream/event");
            const bEvents = subscribeNotifications(wsB, "stream/event");

            const entryIdA = await seedEntryWithChannel(db, { sessionId: sessionA, content: "hi", state: "active" });
            daemon.notifyStreamEvent(sessionA, { entryId: entryIdA, channel: "body", state: "active", contentLength: 2 });

            const entryIdB = await seedEntryWithChannel(db, { sessionId: sessionB, content: "yo", state: "active" });
            daemon.notifyStreamEvent(sessionB, { entryId: entryIdB, channel: "body", state: "active", contentLength: 2 });

            await flush();

            const aCaptured = aEvents() as Array<{ entryId: number }>;
            assert.equal(aCaptured.length, 1);
            assert.equal(aCaptured[0].entryId, entryIdA);

            const bCaptured = bEvents() as Array<{ entryId: number }>;
            assert.equal(bCaptured.length, 1);
            assert.equal(bCaptured[0].entryId, entryIdB);
        } finally { wsA.close(); wsB.close(); }
    });
});

test("appendToChannel + setChannelState forward the entry coordinate onto stream/event (#224)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionResp = await rpcCall(ws, 1, "session.create", { name: "coord-test" });
            const sessionId = (sessionResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { sessionId, content: "hi", state: "active" });

            const notify = (sid: number, ev: { entryId: number; channel: string; state: string; contentLength: number }) =>
                daemon.notifyStreamEvent(sid, ev);
            const coordinate = { loop_seq: 1, turn_seq: 2, sequence: 3 };
            await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "!", notify, coordinate });
            await ChannelWrite.setChannelState(db, { entryId, channel: "body", state: "closed", notify, coordinate });
            await flush();

            const events = captured() as Array<{ loop_seq?: number; turn_seq?: number; sequence?: number }>;
            assert.equal(events.length, 2);
            for (const ev of events) {
                assert.equal(ev.loop_seq, 1, "stream/event carries the coordinate as fields, not buried in the URI (#224)");
                assert.equal(ev.turn_seq, 2);
                assert.equal(ev.sequence, 3);
            }
        } finally { ws.close(); }
    });
});

test("appendToChannel with a mimetype retypes the channel + surfaces it on stream/event (#226)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionResp = await rpcCall(ws, 1, "session.create", { name: "retype-test" });
            const sessionId = (sessionResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            // Seeded text/markdown (the manifest default); a streaming scheme learns the real type per call.
            const entryId = await seedEntryWithChannel(db, { sessionId, content: "", mimetype: "text/markdown", state: "active" });

            const notify = (sid: number, ev: { entryId: number; channel: string; state: string; contentLength: number }) =>
                daemon.notifyStreamEvent(sid, ev);
            // First chunk carries the now-known per-call type → retype.
            await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "{", notify, mimetype: "application/json" });
            // A later chunk omits it — the retype must persist (stored, not per-event).
            await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "}", notify });
            await flush();

            const events = captured() as Array<{ mimetype?: string }>;
            assert.equal(events.length, 2);
            assert.equal(events[0].mimetype, "application/json", "the labelled chunk retypes the channel away from text/markdown + carries it (#226)");
            assert.equal(events[1].mimetype, "application/json", "the retype is stored — a later unlabelled chunk still reports it");
        } finally { ws.close(); }
    });
});
