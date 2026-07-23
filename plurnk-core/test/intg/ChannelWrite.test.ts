// Tests for src/core/ChannelWrite.ts — channel-write helpers + subscription
// registry primitives for streaming schemes.

import test from "node:test";
import assert from "node:assert/strict";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import type { StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker } from "./_helpers.ts";
import Owner from "../../src/core/Owner.ts";

const seedEntryWithChannel = async (channelName: string, channelMime: string, initialContent: string, channelState: "static" | "active" | "closed" | "errored" = "active") => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const entry = await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({
        workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: "/x",
    });
    if (entry === undefined) throw new Error("seed entry failed");
    await (db.test_seed_channel as PrepMethod).run({
        entry_id: entry.id, name: channelName, content: initialContent, mimetype: channelMime, state: channelState,
    });
    return { db, workspaceId, workerId, entryId: entry.id };
};

test("appendToChannel: appends chunk to existing channel content", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "hello");
    try {
        await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: " world" });
        const row = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: entryId, name: "body" });
        assert.equal(row?.content, "hello world");
    } finally { await db.close(); }
});

test("appendToChannel: no-op on nonexistent channel (silent)", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "hello");
    try {
        await ChannelWrite.appendToChannel(db, { entryId, channel: "nonexistent", chunk: "x" });
        const count = (await (db.test_count_channels_for_entry as PrepMethod).get<{ n: number }>({ entry_id: entryId }))?.n;
        assert.equal(count, 1, "no new channel created");
    } finally { await db.close(); }
});

test("appendToChannel: invokes notify with current state + content length", async () => {
    const { db, workspaceId, entryId } = await seedEntryWithChannel("body", "text/plain", "hi", "active");
    try {
        const events: Array<{ workspaceId: number; event: StreamEventPayload }> = [];
        await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "!", notify: (sid, ev) => events.push({ workspaceId: sid, event: ev }) });
        assert.equal(events.length, 1);
        assert.equal(events[0].workspaceId, workspaceId);
        assert.equal(events[0].event.entryId, entryId);
        assert.equal(events[0].event.channel, "body");
        assert.equal(events[0].event.state, "active");
        assert.equal(events[0].event.contentLength, 3);
    } finally { await db.close(); }
});

test("setChannelState: transitions state and notifies", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "data", "active");
    try {
        const events: StreamEventPayload[] = [];
        await ChannelWrite.setChannelState(db, { entryId, channel: "body", state: "closed", notify: (_sid, ev) => events.push(ev) });
        const state = (await (db.test_get_channel as PrepMethod).get<{ state: string }>({ entry_id: entryId, name: "body" }))?.state;
        assert.equal(state, "closed");
        assert.equal(events.length, 1);
        assert.equal(events[0].state, "closed");
    } finally { await db.close(); }
});

test("setChannelState: accepts all four valid states", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "x", "active");
    try {
        for (const s of ["static", "active", "closed", "errored"] as const) {
            await ChannelWrite.setChannelState(db, { entryId, channel: "body", state: s });
            const got = (await (db.test_get_channel as PrepMethod).get<{ state: string }>({ entry_id: entryId, name: "body" }))?.state;
            assert.equal(got, s);
        }
    } finally { await db.close(); }
});

test("openSubscription: inserts a row and returns its id", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "abc-123" });
        assert.ok(subId > 0);
        const row = await (db.test_get_subscription as PrepMethod).get<{ scheme: string; handle: string; closed_at: string | null }>({ id: subId });
        assert.equal(row?.scheme, "sse");
        assert.equal(row?.handle, "abc-123");
        assert.equal(row?.closed_at, null);
    } finally { await db.close(); }
});

test("openSubscription: rejects duplicate active subscription for same (run, entry)", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h1" });
        await assert.rejects(
            () => ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h2" }),
            /UNIQUE constraint/i,
        );
    } finally { await db.close(); }
});

test("openSubscription: allows new subscription after previous one is closed", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const sub1 = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h1" });
        await ChannelWrite.closeSubscription(db, { subscriptionId: sub1, status: 200 });
        const sub2 = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h2" });
        assert.ok(sub2 > sub1);
    } finally { await db.close(); }
});

test("closeSubscription: sets closed_at + close_status", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h" });
        await ChannelWrite.closeSubscription(db, { subscriptionId: subId, status: 499 });
        const row = await (db.test_get_subscription as PrepMethod).get<{ closed_at: string; close_status: number }>({ id: subId });
        assert.ok(row?.closed_at !== null);
        assert.equal(row?.close_status, 499);
    } finally { await db.close(); }
});

test("closeSubscription: idempotent — already-closed subscription is a no-op", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h" });
        await ChannelWrite.closeSubscription(db, { subscriptionId: subId, status: 200 });
        const first = await (db.test_get_subscription as PrepMethod).get<{ closed_at: string }>({ id: subId });
        await ChannelWrite.closeSubscription(db, { subscriptionId: subId, status: 499 });
        const second = await (db.test_get_subscription as PrepMethod).get<{ closed_at: string; close_status: number }>({ id: subId });
        assert.equal(second?.closed_at, first?.closed_at, "closed_at unchanged");
        assert.equal(second?.close_status, 200, "close_status unchanged");
    } finally { await db.close(); }
});

test("findOpenTurnScopedSubscriptionsForWorker selects only turn-scoped (<0>) subs; closed ones drop out", async () => {
    const { db, workspaceId, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        // A turn-scoped (`<0>`) sub and an ordinary (unbounded) sub — on different entries, since
        // there's one active sub per (run, entry). Only the turn-scoped one is reaped at pre-turn.
        const scoped = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sh", handle: "scoped", turnScoped: true });
        const e2 = await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: "/y" });
        if (e2 === undefined) throw new Error("seed entry 2 failed");
        const ordinary = await ChannelWrite.openSubscription(db, { workerId, entryId: e2.id, scheme: "sh", handle: "ordinary" });

        const open = await ChannelWrite.findOpenTurnScopedSubscriptionsForWorker(db, workerId);
        assert.deepEqual(open.map((s) => s.id), [scoped], "only the <0> sub is turn-scoped — the unbounded one is not reaped at pre-turn");
        assert.ok(!open.some((s) => s.id === ordinary), "the unbounded sub is excluded");

        // Once closed (reaped), it drops out — the pre-turn reap is one-shot, never a double-abort.
        await ChannelWrite.closeSubscription(db, { subscriptionId: scoped, status: 499 });
        assert.equal((await ChannelWrite.findOpenTurnScopedSubscriptionsForWorker(db, workerId)).length, 0, "a closed turn-scoped sub is no longer selected");
    } finally { await db.close(); }
});

test("findActiveSubscription: returns active sub for (run, entry)", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h-abc" });
        const found = await ChannelWrite.findActiveSubscription(db, { workerId, entryId });
        assert.ok(found !== null);
        assert.equal(found.id, subId);
        assert.equal(found.scheme, "sse");
        assert.equal(found.handle, "h-abc");
    } finally { await db.close(); }
});

test("findActiveSubscription: returns null when nothing active", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h" });
        await ChannelWrite.closeSubscription(db, { subscriptionId: subId, status: 200 });
        const found = await ChannelWrite.findActiveSubscription(db, { workerId, entryId });
        assert.equal(found, null);
    } finally { await db.close(); }
});

test("findActiveSubscription: returns null for unknown (run, entry)", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const found = await ChannelWrite.findActiveSubscription(db, { workerId, entryId });
        assert.equal(found, null);
    } finally { await db.close(); }
});

test("subscriptions CASCADE on entry delete", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h" });
        await (db.test_delete_entry as PrepMethod).run({ id: entryId });
        const count = (await (db.test_count_subscriptions_for_entry as PrepMethod).get<{ n: number }>({ entry_id: entryId }))?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("subscriptions CASCADE on run delete", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h" });
        await (db.test_delete_run as PrepMethod).run({ id: workerId });
        const count = (await (db.test_count_subscriptions_for_run as PrepMethod).get<{ n: number }>({ worker_id: workerId }))?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("subscriptions CHECK: closed_at and close_status must be paired", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        await assert.rejects(
            () => (db.test_invalid_subscription_only_closed_at as PrepMethod).run({ worker_id: workerId, entry_id: entryId }),
            /CHECK constraint/i,
        );
        await assert.rejects(
            () => (db.test_invalid_subscription_only_close_status as PrepMethod).run({ worker_id: workerId, entry_id: entryId }),
            /CHECK constraint/i,
        );
    } finally { await db.close(); }
});
