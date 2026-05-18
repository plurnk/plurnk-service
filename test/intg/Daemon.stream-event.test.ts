// Tests for daemon's stream/event notification. SPEC §7.9 + §13.6.
// Verifies notifications fire when ChannelWrite helpers update channels, and
// are scoped to the session containing the entry.

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { DatabaseSync } from "node:sqlite";
import Daemon from "../../src/server/Daemon.ts";
import { appendToChannel, setChannelState } from "../../src/core/ChannelWrite.ts";
import { openMigrated } from "./_helpers.ts";

interface RpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
}

const rpcCall = (ws: WebSocket, id: number, method: string, params?: object): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text) as RpcResponse;
            if (parsed.id === id) { ws.off("message", onMessage); resolve(parsed); }
        };
        ws.on("message", onMessage);
        ws.on("error", reject);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

const subscribeNotifications = (ws: WebSocket, method: string): (() => unknown[]) => {
    const captured: unknown[] = [];
    ws.on("message", (data) => {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const parsed = JSON.parse(text) as { method?: string; params?: unknown; id?: unknown };
        if (parsed.id === undefined && parsed.method === method) captured.push(parsed.params);
    });
    return () => captured;
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

const withDaemon = async <T>(fn: (db: DatabaseSync, daemon: Daemon, addr: { host: string; port: number }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    try { return await fn(db, daemon, addr); }
    finally { await daemon.stop(); db.close(); }
};

const connect = (addr: { host: string; port: number }): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });

const seedEntryWithChannel = (db: DatabaseSync, sessionId: number, channelName: string, content: string, state: string) => {
    const entry = db
        .prepare("INSERT INTO entries (scope, session_id, scheme, pathname) VALUES ('session', ?, 'known', 'x') RETURNING id")
        .get(sessionId) as { id: number };
    db.prepare(
        "INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens, state) VALUES (?, ?, ?, 'text/plain', 0, ?)",
    ).run(entry.id, channelName, content, state);
    return entry.id;
};

test("daemon registers stream/event in discover catalog", async () => {
    await withDaemon(async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "discover");
            const cat = r.result as { notifications: Record<string, { description?: string }> };
            assert.ok(cat.notifications["stream/event"] !== undefined);
        } finally { ws.close(); }
    });
});

test("notifyStreamEvent broadcasts to clients attached to the entry's session", async () => {
    await withDaemon(async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionResp = await rpcCall(ws, 1, "session.create", { name: "stream-test" });
            const sessionId = (sessionResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");

            // Seed an entry + channel directly
            const entryId = seedEntryWithChannel(db, sessionId, "body", "hello", "active");

            // Fire a stream/event manually via the daemon API
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
    await withDaemon(async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionResp = await rpcCall(ws, 1, "session.create", { name: "append-test" });
            const sessionId = (sessionResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = seedEntryWithChannel(db, sessionId, "body", "hi", "active");

            const notify = (sid: number, ev: { entryId: number; channel: string; state: string; contentLength: number }) =>
                daemon.notifyStreamEvent(sid, ev);
            appendToChannel(db, { entryId, channel: "body", chunk: "!", notify });
            appendToChannel(db, { entryId, channel: "body", chunk: "?", notify });
            await flush();

            const events = captured() as Array<{ contentLength: number }>;
            assert.equal(events.length, 2);
            assert.equal(events[0].contentLength, 3);  // "hi" + "!"
            assert.equal(events[1].contentLength, 4);  // "hi!" + "?"
        } finally { ws.close(); }
    });
});

test("setChannelState end-to-end fires stream/event with state change", async () => {
    await withDaemon(async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionResp = await rpcCall(ws, 1, "session.create", { name: "state-test" });
            const sessionId = (sessionResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = seedEntryWithChannel(db, sessionId, "body", "done", "active");

            setChannelState(db, { entryId, channel: "body", state: "closed", notify: (sid, ev) => daemon.notifyStreamEvent(sid, ev) });
            await flush();

            const events = captured() as Array<{ state: string }>;
            assert.equal(events.length, 1);
            assert.equal(events[0].state, "closed");
        } finally { ws.close(); }
    });
});

test("stream/event is session-scoped — other sessions don't see it", async () => {
    await withDaemon(async (db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aResp = await rpcCall(wsA, 1, "session.create", { name: "session-A" });
            const bResp = await rpcCall(wsB, 1, "session.create", { name: "session-B" });
            const sessionA = (aResp.result as { id: number }).id;
            const sessionB = (bResp.result as { id: number }).id;

            const aEvents = subscribeNotifications(wsA, "stream/event");
            const bEvents = subscribeNotifications(wsB, "stream/event");

            // Seed an entry in session A
            const entryIdA = seedEntryWithChannel(db, sessionA, "body", "hi", "active");
            daemon.notifyStreamEvent(sessionA, { entryId: entryIdA, channel: "body", state: "active", contentLength: 2 });

            // Seed an entry in session B
            const entryIdB = seedEntryWithChannel(db, sessionB, "body", "yo", "active");
            daemon.notifyStreamEvent(sessionB, { entryId: entryIdB, channel: "body", state: "active", contentLength: 2 });

            await flush();

            // A sees only its own event
            const aCaptured = aEvents() as Array<{ entryId: number }>;
            assert.equal(aCaptured.length, 1);
            assert.equal(aCaptured[0].entryId, entryIdA);

            // B sees only its own event
            const bCaptured = bEvents() as Array<{ entryId: number }>;
            assert.equal(bCaptured.length, 1);
            assert.equal(bCaptured[0].entryId, entryIdB);
        } finally { wsA.close(); wsB.close(); }
    });
});
