// Tests for src/core/ChannelWrite.ts — channel-write helpers + subscription
// registry primitives for streaming schemes.

import test from "node:test";
import assert from "node:assert/strict";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import type { StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import { Results } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertWorker } from "./_helpers.ts";
import Owner from "../../src/core/Owner.ts";
import { contentWeight } from "../../src/core/content-weight.ts";

const seedEntryWithChannel = async (channelName: string, channelMime: string, initialContent: string, channelState: "static" | "active" | "closed" | "errored" = "active") => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const ownerId = await Owner.commonsId(db, workspaceId);
    const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
        workspace_id: workspaceId, owner_id: ownerId, scheme: "worker", pathname: "/x",
    });
    if (entry === undefined) throw new Error("seed entry failed");
    await db.test_seed_channel.run({
        entry_id: entry.id, name: channelName, content: initialContent, mimetype: channelMime, state: channelState,
    });
    return { db, workspaceId, workerId, ownerId, entryId: entry.id };
};

test("appendToChannel: appends chunk to existing channel content", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "hello");
    try {
        await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: " world" });
        const row = await db.test_get_channel.get<{ content: string }>({ entry_id: entryId, name: "body" });
        assert.equal(row?.content, "hello world");
    } finally { await db.close(); }
});

test("appendToChannel: every append stores the ruler weight of the complete channel (#178)", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "A😀");
    try {
        await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "é" });
        const first = await db.test_get_channel.get<{ content: string; weight: number }>({ entry_id: entryId, name: "body" });
        assert.equal(first?.content, "A😀é");
        assert.equal(first?.weight, contentWeight("A😀é"));

        await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "Z" });
        const second = await db.test_get_channel.get<{ content: string; weight: number }>({ entry_id: entryId, name: "body" });
        assert.equal(second?.content, "A😀éZ");
        assert.equal(second?.weight, contentWeight("A😀éZ"));
    } finally { await db.close(); }
});

test("appendToChannel: no-op on nonexistent channel (silent)", async () => {
    const { db, entryId } = await seedEntryWithChannel("body", "text/plain", "hello");
    try {
        await ChannelWrite.appendToChannel(db, { entryId, channel: "nonexistent", chunk: "x" });
        const count = (await db.test_count_channels_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n;
        assert.equal(count, 1, "no new channel created");
    } finally { await db.close(); }
});

test("appendToChannel: invokes notify with owner, current state, and content length", async () => {
    const { db, workspaceId, ownerId, entryId } = await seedEntryWithChannel("body", "text/plain", "hi", "active");
    try {
        const events: Array<{ workspaceId: number; event: StreamEventPayload }> = [];
        await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "!", notify: (sid, ev) => events.push({ workspaceId: sid, event: ev }) });
        assert.equal(events.length, 1);
        assert.equal(events[0].workspaceId, workspaceId);
        assert.equal(events[0].event.entryId, entryId);
        assert.equal(events[0].event.workerId, ownerId);
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
        const state = (await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "body" }))?.state;
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
            const got = (await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "body" }))?.state;
            assert.equal(got, s);
        }
    } finally { await db.close(); }
});

test("openSubscription: inserts a row and returns its id", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "abc-123" });
        assert.ok(subId > 0);
        const row = await db.test_get_subscription.get<{ scheme: string; handle: string; closed_at: string | null }>({ id: subId });
        assert.equal(row?.scheme, "sse");
        assert.equal(row?.handle, "abc-123");
        assert.equal(row?.closed_at, null);
    } finally { await db.close(); }
});

test("{§exec-poll} #106: subscriptions preserve disabled, default, and fixed poll policy", async () => {
    const { db, workspaceId, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const disabledId = await ChannelWrite.openSubscription(db, {
            workerId,
            entryId,
            scheme: "sh",
            handle: "disabled",
            pollSeconds: 0,
        });
        const disabled = await db.test_get_subscription.get<{ poll_seconds: number | null }>({ id: disabledId });
        assert.equal(disabled?.poll_seconds, 0, "explicit zero survives as the stream's disabled policy");
        assert.deepEqual(
            await db.drain_worker_min_poll.get({ worker_id: workerId }),
            { open_count: 1, poll_seconds: 0 },
            "zero alone arms no worker timer",
        );

        const seed = async (pathname: string): Promise<number> => {
            const row = await db.test_seed_entry_workspace.get<{ id: number }>({
                workspace_id: workspaceId,
                owner_id: await Owner.commonsId(db, workspaceId),
                scheme: "worker",
                pathname,
            });
            if (row === undefined) throw new Error(`seed ${pathname} failed`);
            await db.test_seed_channel.run({
                entry_id: row.id,
                name: "body",
                content: "",
                mimetype: "text/plain",
                state: "active",
            });
            return row.id;
        };
        await ChannelWrite.openSubscription(db, {
            workerId,
            entryId: await seed("/default-poll"),
            scheme: "sh",
            handle: "default",
        });
        assert.deepEqual(
            await db.drain_worker_min_poll.get({ worker_id: workerId }),
            { open_count: 2, poll_seconds: null },
            "an omitted cadence still arms default backoff; a disabled sibling cannot suppress it",
        );

        await ChannelWrite.openSubscription(db, {
            workerId,
            entryId: await seed("/fixed-poll"),
            scheme: "sh",
            handle: "fixed",
            pollSeconds: 3,
        });
        assert.deepEqual(
            await db.drain_worker_min_poll.get({ worker_id: workerId }),
            { open_count: 3, poll_seconds: 3 },
            "the tightest fixed cadence wins when any open stream requests one",
        );
    } finally { await db.close(); }
});

test("openSubscription: rejects duplicate active subscription for same (worker, entry)", async () => {
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
        await ChannelWrite.closeSubscription(db, { subscriptionId: sub1, result: { status: 200 } });
        const sub2 = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h2" });
        assert.ok(sub2 > sub1);
    } finally { await db.close(); }
});

test("closeSubscription: persists the exact result and indexed status", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h" });
        const result = Results.failure("scheme:test", "cancelled", 499, "The test stream was cancelled.");
        await ChannelWrite.closeSubscription(db, { subscriptionId: subId, result });
        const row = await db.test_get_subscription.get<{ closed_at: string; close_status: number; close_result: string; channel_results: string }>({ id: subId });
        assert.ok(row?.closed_at !== null);
        assert.equal(row?.close_status, 499);
        assert.deepEqual(JSON.parse(row?.close_result ?? "null"), result);
        assert.deepEqual(JSON.parse(row?.channel_results ?? "null"), {});
        const channel = await db.test_get_channel_terminal.get<{ state: string; producer_result: string }>({
            entry_id: entryId,
            name: "body",
        });
        assert.equal(channel?.state, "errored");
        assert.deepEqual(JSON.parse(channel?.producer_result ?? "null"), result);
    } finally { await db.close(); }
});

test("closeSubscription: idempotent — already-closed subscription is a no-op", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h" });
        await ChannelWrite.closeSubscription(db, { subscriptionId: subId, result: { status: 200 } });
        const first = await db.test_get_subscription.get<{ closed_at: string }>({ id: subId });
        await ChannelWrite.closeSubscription(db, {
            subscriptionId: subId,
            result: Results.failure("scheme:test", "cancelled", 499, "The test stream was cancelled."),
        });
        const second = await db.test_get_subscription.get<{ closed_at: string; close_status: number; close_result: string }>({ id: subId });
        assert.equal(second?.closed_at, first?.closed_at, "closed_at unchanged");
        assert.equal(second?.close_status, 200, "close_status unchanged");
        assert.deepEqual(JSON.parse(second?.close_result ?? "null"), { status: 200 }, "close_result unchanged");
    } finally { await db.close(); }
});

test("findOpenTurnScopedSubscriptionsForWorker selects only turn-scoped (<0>) subs; closed ones drop out", async () => {
    const { db, workspaceId, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        // A turn-scoped (`<0>`) sub and an ordinary (unbounded) sub — on different entries, since
        // there's one active sub per (worker, entry). Only the turn-scoped one is reaped at pre-turn.
        const scoped = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sh", handle: "scoped", turnScoped: true });
        const e2 = await db.test_seed_entry_workspace.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: "/y" });
        if (e2 === undefined) throw new Error("seed entry 2 failed");
        await db.test_seed_channel.run({
            entry_id: e2.id,
            name: "body",
            content: "",
            mimetype: "text/plain",
            state: "active",
        });
        const ordinary = await ChannelWrite.openSubscription(db, { workerId, entryId: e2.id, scheme: "sh", handle: "ordinary" });

        const open = await ChannelWrite.findOpenTurnScopedSubscriptionsForWorker(db, workerId);
        assert.deepEqual(open.map((s) => s.id), [scoped], "only the <0> sub is turn-scoped — the unbounded one is not reaped at pre-turn");
        assert.ok(!open.some((s) => s.id === ordinary), "the unbounded sub is excluded");

        // Once closed (reaped), it drops out — the pre-turn reap is one-shot, never a double-abort.
        await ChannelWrite.closeSubscription(db, {
            subscriptionId: scoped,
            result: Results.failure("scheme:test", "cancelled", 499, "The test stream was cancelled."),
        });
        assert.equal((await ChannelWrite.findOpenTurnScopedSubscriptionsForWorker(db, workerId)).length, 0, "a closed turn-scoped sub is no longer selected");
    } finally { await db.close(); }
});

test("findActiveSubscription: returns active sub for (worker, entry)", async () => {
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
        await ChannelWrite.closeSubscription(db, { subscriptionId: subId, result: { status: 200 } });
        const found = await ChannelWrite.findActiveSubscription(db, { workerId, entryId });
        assert.equal(found, null);
    } finally { await db.close(); }
});

test("findActiveSubscription: returns null for unknown (worker, entry)", async () => {
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
        await db.test_delete_entry.run({ id: entryId });
        const count = (await db.test_count_subscriptions_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("subscriptions CASCADE on worker delete", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "h" });
        await db.test_delete_worker.run({ id: workerId });
        const count = (await db.test_count_subscriptions_for_worker.get<{ n: number }>({ worker_id: workerId }))?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("subscriptions must open before any settlement fields can be stored", async () => {
    const { db, workerId, entryId } = await seedEntryWithChannel("body", "text/plain", "");
    try {
        await assert.rejects(
            () => db.test_invalid_subscription_only_closed_at.run({ worker_id: workerId, entry_id: entryId }),
            /subscription must open before it can settle/,
        );
        await assert.rejects(
            () => db.test_invalid_subscription_only_close_status.run({ worker_id: workerId, entry_id: entryId }),
            /subscription must open before it can settle/,
        );
    } finally { await db.close(); }
});
