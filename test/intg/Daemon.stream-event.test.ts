// Tests for daemon's stream/event notification. SPEC §7.9 + §13.6.

import test from "node:test";
import assert from "node:assert/strict";
import { appendToChannel, setChannelState } from "../../src/core/ChannelWrite.ts";
import { seedEntryWithChannel } from "./_helpers.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";

test("daemon registers stream/event in discover catalog", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "discover");
            const cat = r.result as { notifications: Record<string, { description?: string }> };
            assert.ok(cat.notifications["stream/event"] !== undefined);
        } finally { ws.close(); }
    });
});

test("notifyStreamEvent broadcasts to clients attached to the entry's session", async () => {
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
            const evt = captured()[0] as { entryId: number; channel: string; state: string; contentLength: number };
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
            await appendToChannel(db, { entryId, channel: "body", chunk: "!", notify });
            await appendToChannel(db, { entryId, channel: "body", chunk: "?", notify });
            await flush();

            const events = captured() as Array<{ contentLength: number }>;
            assert.equal(events.length, 2);
            assert.equal(events[0].contentLength, 3);
            assert.equal(events[1].contentLength, 4);
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

            await setChannelState(db, { entryId, channel: "body", state: "closed", notify: (sid, ev) => daemon.notifyStreamEvent(sid, ev) });
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
