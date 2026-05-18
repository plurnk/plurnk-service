// Tests for src/core/ChannelWrite.ts — channel-write helpers + subscription
// registry primitives for streaming schemes.

import test from "node:test";
import assert from "node:assert/strict";
import {
    appendToChannel,
    setChannelState,
    openSubscription,
    closeSubscription,
    findActiveSubscription,
} from "../../src/core/ChannelWrite.ts";
import type { StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

// Helper: seed an entry with one channel directly in the DB so the
// ChannelWrite helpers have something to operate on.
const seedEntryWithChannel = async (channelName: string, channelMime: string, initialContent: string, channelState: "static" | "active" | "closed" | "errored" = "active") => {
    const db = await openMigrated();
    const sessionId = insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = insertRun(db, sessionId);
    const entry = db
        .prepare("INSERT INTO entries (scope, session_id, scheme, pathname) VALUES ('session', ?, 'known', 'x') RETURNING id")
        .get(sessionId) as { id: number };
    db.prepare(
        "INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens, state) VALUES (?, ?, ?, ?, 0, ?)",
    ).run(entry.id, channelName, initialContent, channelMime, channelState);
    return { db, sessionId, runId, entryId: entry.id };
};

test("appendToChannel: appends chunk to existing channel content", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "hello");
    try {
        appendToChannel(db, { entryId, channel: "body", chunk: " world" });
        const content = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(entryId) as { content: string }).content;
        assert.equal(content, "hello world");
    } finally { db.close(); }
});

test("appendToChannel: no-op on nonexistent channel (silent)", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "hello");
    try {
        // Doesn't throw; just doesn't update anything.
        appendToChannel(db, { entryId, channel: "nonexistent", chunk: "x" });
        const count = (db.prepare("SELECT COUNT(*) as n FROM entry_channels WHERE entry_id = ?").get(entryId) as { n: number }).n;
        assert.equal(count, 1, "no new channel created");
    } finally { db.close(); }
});

test("appendToChannel: invokes notify with current state + content length", async () => {
    const { db, sessionId, entryId } = await seedEntryWithChannel("body", "text/plain", "hi", "active");
    try {
        const events: Array<{ sessionId: number; event: StreamEventPayload }> = [];
        appendToChannel(db, { entryId, channel: "body", chunk: "!", notify: (sid, ev) => events.push({ sessionId: sid, event: ev }) });
        assert.equal(events.length, 1);
        assert.equal(events[0].sessionId, sessionId);
        assert.equal(events[0].event.entryId, entryId);
        assert.equal(events[0].event.channel, "body");
        assert.equal(events[0].event.state, "active");
        assert.equal(events[0].event.contentLength, 3);  // "hi" + "!"
    } finally { db.close(); }
});

test("setChannelState: transitions state and notifies", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "data", "active");
    try {
        const events: StreamEventPayload[] = [];
        setChannelState(db, { entryId, channel: "body", state: "closed", notify: (_sid, ev) => events.push(ev) });
        const state = (db.prepare("SELECT state FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(entryId) as { state: string }).state;
        assert.equal(state, "closed");
        assert.equal(events.length, 1);
        assert.equal(events[0].state, "closed");
    } finally { db.close(); }
});

test("setChannelState: accepts all four valid states", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "x", "active");
    try {
        for (const s of ["static", "active", "closed", "errored"] as const) {
            setChannelState(db, { entryId, channel: "body", state: s });
            const got = (db.prepare("SELECT state FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(entryId) as { state: string }).state;
            assert.equal(got, s);
        }
    } finally { db.close(); }
});

test("openSubscription: inserts a row and returns its id", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = openSubscription(db, { runId, entryId, scheme: "sse", handle: "abc-123" });
        assert.ok(subId > 0);
        const row = db.prepare("SELECT scheme, handle, closed_at FROM subscriptions WHERE id = ?").get(subId) as { scheme: string; handle: string; closed_at: string | null };
        assert.equal(row.scheme, "sse");
        assert.equal(row.handle, "abc-123");
        assert.equal(row.closed_at, null);
    } finally { db.close(); }
});

test("openSubscription: rejects duplicate active subscription for same (run, entry)", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        openSubscription(db, { runId, entryId, scheme: "sse", handle: "h1" });
        assert.throws(
            () => openSubscription(db, { runId, entryId, scheme: "sse", handle: "h2" }),
            /UNIQUE constraint/i,
        );
    } finally { db.close(); }
});

test("openSubscription: allows new subscription after previous one is closed", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const sub1 = openSubscription(db, { runId, entryId, scheme: "sse", handle: "h1" });
        closeSubscription(db, { subscriptionId: sub1, status: 200 });
        // Now a new subscription for the same (run, entry) is allowed
        const sub2 = openSubscription(db, { runId, entryId, scheme: "sse", handle: "h2" });
        assert.ok(sub2 > sub1);
    } finally { db.close(); }
});

test("closeSubscription: sets closed_at + close_status", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = openSubscription(db, { runId, entryId, scheme: "sse", handle: "h" });
        closeSubscription(db, { subscriptionId: subId, status: 499 });
        const row = db.prepare("SELECT closed_at, close_status FROM subscriptions WHERE id = ?").get(subId) as { closed_at: string; close_status: number };
        assert.ok(row.closed_at !== null);
        assert.equal(row.close_status, 499);
    } finally { db.close(); }
});

test("closeSubscription: idempotent — already-closed subscription is a no-op", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = openSubscription(db, { runId, entryId, scheme: "sse", handle: "h" });
        closeSubscription(db, { subscriptionId: subId, status: 200 });
        const firstCloseAt = (db.prepare("SELECT closed_at FROM subscriptions WHERE id = ?").get(subId) as { closed_at: string }).closed_at;
        closeSubscription(db, { subscriptionId: subId, status: 499 });
        const secondCloseAt = (db.prepare("SELECT closed_at, close_status FROM subscriptions WHERE id = ?").get(subId) as { closed_at: string; close_status: number });
        assert.equal(secondCloseAt.closed_at, firstCloseAt, "closed_at unchanged");
        assert.equal(secondCloseAt.close_status, 200, "close_status unchanged");
    } finally { db.close(); }
});

test("findActiveSubscription: returns active sub for (run, entry)", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = openSubscription(db, { runId, entryId, scheme: "sse", handle: "h-abc" });
        const found = findActiveSubscription(db, { runId, entryId });
        assert.ok(found !== null);
        assert.equal(found.id, subId);
        assert.equal(found.scheme, "sse");
        assert.equal(found.handle, "h-abc");
    } finally { db.close(); }
});

test("findActiveSubscription: returns null when nothing active", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = openSubscription(db, { runId, entryId, scheme: "sse", handle: "h" });
        closeSubscription(db, { subscriptionId: subId, status: 200 });
        const found = findActiveSubscription(db, { runId, entryId });
        assert.equal(found, null);
    } finally { db.close(); }
});

test("findActiveSubscription: returns null for unknown (run, entry)", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const found = findActiveSubscription(db, { runId, entryId });
        assert.equal(found, null);
    } finally { db.close(); }
});

test("subscriptions CASCADE on entry delete", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        openSubscription(db, { runId, entryId, scheme: "sse", handle: "h" });
        db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
        const count = (db.prepare("SELECT COUNT(*) as n FROM subscriptions WHERE entry_id = ?").get(entryId) as { n: number }).n;
        assert.equal(count, 0);
    } finally { db.close(); }
});

test("subscriptions CASCADE on run delete", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        openSubscription(db, { runId, entryId, scheme: "sse", handle: "h" });
        db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
        const count = (db.prepare("SELECT COUNT(*) as n FROM subscriptions WHERE run_id = ?").get(runId) as { n: number }).n;
        assert.equal(count, 0);
    } finally { db.close(); }
});

test("subscriptions CHECK: closed_at and close_status must be paired", async () => {
    const { db, runId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        // Cannot insert with only closed_at set
        assert.throws(
            () => db.prepare("INSERT INTO subscriptions (run_id, entry_id, scheme, handle, closed_at) VALUES (?, ?, 'sse', 'h', '2026-01-01T00:00:00Z')").run(runId, entryId),
            /CHECK constraint/i,
        );
        // Cannot insert with only close_status set
        assert.throws(
            () => db.prepare("INSERT INTO subscriptions (run_id, entry_id, scheme, handle, close_status) VALUES (?, ?, 'sse', 'h', 200)").run(runId, entryId),
            /CHECK constraint/i,
        );
    } finally { db.close(); }
});
