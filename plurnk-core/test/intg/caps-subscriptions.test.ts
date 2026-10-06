// Conformance: plurnk-schemes {§scheme-subscriptions} — the streaming
// open → notifyChunk → close lifecycle an extension drives against real
// SQLite: content appends + stream/events, terminal channel state, registry
// close, worker wake with the summary, and worker abort → signal + handle cancel.

import test from "node:test";
import assert from "node:assert/strict";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbSubscriptionCaps from "../../src/core/caps/DbSubscriptionCaps.ts";
import ChannelWrite, { type WakeWorkerPayload, type StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import { openMigrated, insertWorkspace, insertWorker } from "./_db.ts";
import { makeSchemeCtx, schemeManifest } from "./_scheme.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";
import { Results } from "@plurnk/plurnk-schemes";

test("{§per-entry-channels} DbSubscriptionCaps: open binds + composes abort, notifyChunk streams, close terminates + wakes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-sub-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const streamEvents: StreamEventPayload[] = [];
        const wakes: WakeWorkerPayload[] = [];
        const parentAbort = new AbortController();
        const ctx = makeSchemeCtx({
            db, workspaceId, workerId, signal: parentAbort.signal,
            streamEventNotify: (_s, e) => streamEvents.push(e),
            wakeWorkerNotify: (p) => wakes.push(p),
        });
        const entries = new DbEntryCaps(ctx, "exec", schemeManifest("exec", { stdout: "text/plain", stderr: "text/plain" }, "stdout"), "");
        const liveSubscriptions = new LiveSubscriptions();
        const subs = new DbSubscriptionCaps(ctx, "exec", "", liveSubscriptions, "stdout");

        const seeded = await entries.write("/run", { channels: {
            stdout: { content: "", mimetype: "text/plain", state: "active" },
            stderr: { content: "", mimetype: "text/plain", state: "active" },
        } });
        const entryId = seeded.entryId as number;

        // open → a live (un-aborted) signal
        let cancelCalls = 0;
        const signal = await subs.open("/run", { cancel: () => { cancelCalls += 1; } });
        assert.equal(signal.aborted, false);
        const subscription = await db.find_active_subscription.get<{ id: number }>({ entry_id: entryId });
        const publication = await db.test_subscription_published_channel.get<{ published_channel: string | null }>({ id: subscription?.id });
        assert.equal(publication?.published_channel, "stdout", "the model-facing selection persists through the completion wake");

        // notifyChunk → content appends + each fires a stream/event
        await subs.notifyChunk("stdout", "hello ");
        await subs.notifyChunk("stderr", "diagnostic");
        await subs.notifyChunk("stdout", "world");
        assert.equal((await entries.read("/run")).entry?.channels.stdout.content, "hello world");
        assert.equal((await entries.read("/run")).entry?.channels.stderr.content, "diagnostic", "unpublished auxiliary content is still durable");
        assert.ok(streamEvents.length >= 2, "each chunk fired a stream/event");
        assert.ok(streamEvents.every((event) => event.workerId === workerId), "stream updates identify their producer");

        // close(result) → channel terminal, exact result persisted, worker woken with the summary
        await subs.close({ status: 200 }, "exit 0; 11 bytes");
        assert.ok(streamEvents.every((event) => event.channel === "stdout"), "only the selected default channel is published");
        const meta = await db.channel_meta.get<{ state: string }>({ entry_id: entryId, channel: "stdout" });
        assert.equal(meta?.state, "closed");
        assert.equal((await entries.read("/run")).entry?.channels.stdout.state, "closed");
        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].workerId, workerId, "the lifecycle wake still targets the invoking worker");
        assert.deepEqual(wakes[0].result, { status: 200 });
        assert.equal(wakes[0].summary, "exit 0; 11 bytes");
        assert.equal(wakes[0].target, "exec:///run");

        // A producer may preserve successfully acquired auxiliary evidence when
        // the default body fails; overrides are exact and validated before writes.
        await entries.write("/mixed", { channels: {
            stdout: { content: "", mimetype: "text/plain", state: "active" },
            stderr: { content: "evidence", mimetype: "text/plain", state: "active" },
        } });
        await subs.open("/mixed", { cancel: () => {} });
        const bodyFailure = Results.failure("scheme:exec", "body-failed", 500, "The default body failed.");
        await assert.rejects(
            () => subs.close(bodyFailure, "bad override", { missing: { status: 200 } }),
            /subscription channel result violates the channel producer contract/,
        );
        assert.equal((await entries.read("/mixed")).entry?.channels.stdout.state, "active");
        await subs.close(bodyFailure, "body failed", { stderr: { status: 200 } });
        const mixed = await entries.read("/mixed");
        assert.equal(mixed.entry?.channels.stdout.state, "errored");
        assert.equal(mixed.entry?.channels.stderr.state, "closed");
        assert.deepEqual(mixed.entry?.channels.stdout.producerResult, bodyFailure);
        assert.deepEqual(mixed.entry?.channels.stderr.producerResult, { status: 200 });

        // a worker abort propagates to the subscription signal AND force-cancels the handle
        await entries.write("/run2", { channels: {
            stdout: { content: "", mimetype: "text/plain", state: "active" },
        } });
        const signal2 = await subs.open("/run2", { cancel: () => { cancelCalls += 1; } });
        const entry2 = await entries.read("/run2");
        assert.equal(entry2.status, 200);
        const sub2 = await db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        const cancelledId = sub2.at(-1)?.id;
        assert.ok(cancelledId !== undefined);
        parentAbort.abort();
        assert.equal(signal2.aborted, true, "worker abort propagates to the subscription signal");
        assert.equal(cancelCalls, 1, "worker abort force-cancels the sibling handle");
        assert.equal(await liveSubscriptions.cancel(cancelledId), true);
        assert.equal(cancelCalls, 1, "the registry reap coalesces with signal cancellation");
        const cancelledResult = Results.failure("scheme:exec", "cancelled", 499, "The worker cancelled the stream.");
        await subs.close(cancelledResult, "worker cancelled");
        const cancelledRow = await db.test_get_subscription.get<{ close_status: number; close_result: string }>({ id: cancelledId });
        assert.equal(cancelledRow?.close_status, 499, "cancelled settlement is durable 499");
        assert.deepEqual(JSON.parse(cancelledRow?.close_result ?? "null"), cancelledResult);
        assert.equal(
            (await entries.read("/run2")).entry?.channels.stdout.state,
            "errored",
            "a cancelled stream is terminal but not a complete representation",
        );

        // open on an absent entry → throws (a subscription needs its entry)
        await assert.rejects(() => subs.open("/missing", { cancel: () => {} }), /no entry/);
    } finally { await db.close(); }
});

test("{§subscriptions-subscription-registry-routes-cancellation} notification failure after durable close still releases ownership and wakes the worker", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `close-notify-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const failure = new Error("fixture notification failure");
        const wakes: WakeWorkerPayload[] = [];
        const ctx = makeSchemeCtx({
            db, workspaceId, workerId,
            streamEventNotify: () => { throw failure; }, wakeWorkerNotify: (event) => wakes.push(event),
        });
        const entries = new DbEntryCaps(ctx, "exec", schemeManifest("exec", { stdout: "text/plain" }, "stdout"), "");
        const live = new LiveSubscriptions();
        const subscriptions = new DbSubscriptionCaps(ctx, "exec", "", live, "stdout");
        const entry = await entries.write("/run", { channels: { stdout: { content: "", mimetype: "text/plain", state: "active" } } });
        let cancellations = 0;
        const subscription = await subscriptions.open("/run", { cancel: () => { cancellations++; } });
        const row = await db.find_active_subscription.get<{ id: number }>({ entry_id: entry.entryId });
        assert.ok(row);
        await assert.rejects(subscription.close({ status: 200 }), (cause) => cause === failure);
        assert.equal((await db.test_get_subscription.get<{ close_status: number }>({ id: row.id }))?.close_status, 200);
        assert.equal(await live.cancel(row.id), false, "a committed terminal subscription has no remaining cancellation owner");
        assert.equal(cancellations, 0);
        assert.equal(wakes.length, 1, "an observer failure cannot suppress the terminal wake");
        assert.deepEqual(wakes[0].result, { status: 200 });
        await subscription.close({ status: 200 });
        assert.equal(wakes.length, 1, "repeated closure never repeats post-commit delivery");
    } finally { await db.close(); }
});

for (const cancelledBeforeClose of [false, true]) {
test(`{§subscription-finalization} failed durable closure can retry settlement without recancelling the producer (prior cancellation: ${cancelledBeforeClose})`, async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `close-retry-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const wakes: WakeWorkerPayload[] = [];
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, wakeWorkerNotify: (event) => wakes.push(event) });
        const entries = new DbEntryCaps(ctx, "exec", schemeManifest("exec", { stdout: "text/plain" }, "stdout"), "");
        const live = new LiveSubscriptions();
        const subscriptions = new DbSubscriptionCaps(ctx, "exec", "", live, "stdout");
        const entry = await entries.write("/run", { channels: { stdout: { content: "done", mimetype: "text/plain", state: "active" } } });
        let cancellations = 0;
        const subscription = await subscriptions.open("/run", { cancel: () => { cancellations++; } });
        const row = await db.find_active_subscription.get<{ id: number }>({ entry_id: entry.entryId });
        assert.ok(row);
        if (cancelledBeforeClose) assert.equal(await live.cancel(row.id), true);
        const failure = new Error("fixture durable close unavailable");
        t.mock.method(ChannelWrite, "closeSubscription", async () => { throw failure; }, { times: 2 });
        await assert.rejects(subscription.close({ status: 200 }, "finished"), (cause) => cause === failure);
        await assert.rejects(live.cancel(row.id), (cause) => cause === failure);
        assert.equal(wakes.length, 0, "nothing announces a closure that has not committed");
        assert.equal((await db.find_open_subscriptions_for_worker.all({ worker_id: workerId })).length, 1);
        assert.equal(await live.cancel(row.id), true);
        assert.equal((await db.find_open_subscriptions_for_worker.all({ worker_id: workerId })).length, 0);
        assert.equal(wakes.length, 1);
        assert.deepEqual(wakes[0].result, { status: 200 });
        assert.equal(wakes[0].summary, "finished");
        assert.equal(cancellations, cancelledBeforeClose ? 1 : 0, "settlement retries do not call the ended producer");
        await subscription.close({ status: 200 });
        assert.equal(wakes.length, 1);
        assert.equal(await live.cancel(row.id), false);
    } finally { await db.close(); }
});
}

test("{§subscription-finalization} concurrent close and cancellation share the first terminal outcome and one wake", async (t) => {
    const db = await openMigrated();
    const release = Promise.withResolvers<void>();
    try {
        const workspaceId = await insertWorkspace(db, `close-concurrent-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const wakes: WakeWorkerPayload[] = [];
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, wakeWorkerNotify: (event) => wakes.push(event) });
        const entries = new DbEntryCaps(ctx, "exec", schemeManifest("exec", { stdout: "text/plain" }, "stdout"), "");
        const live = new LiveSubscriptions();
        const subs = new DbSubscriptionCaps(ctx, "exec", "", live, "stdout");
        const entry = await entries.write("/run", { channels: { stdout: { content: "", mimetype: "text/plain", state: "active" } } });
        const subscription = await subs.open("/run", { cancel: () => assert.fail("settling is not running") });
        const row = await db.find_active_subscription.get<{ id: number }>({ entry_id: entry.entryId });
        assert.ok(row);
        const original = ChannelWrite.closeSubscription;
        const close = t.mock.method(ChannelWrite, "closeSubscription", async (...args: Parameters<typeof original>) => {
            await release.promise;
            return original(...args);
        });
        const first = subscription.close({ status: 200 }, "first");
        const second = subscription.close(Results.failure("scheme:exec", "cancelled", 499, "cancelled"), "second");
        assert.equal(first, second);
        const cancelled = live.cancel(row.id);
        assert.equal(close.mock.callCount(), 1);
        release.resolve();
        await first;
        assert.equal(await cancelled, true);
        assert.equal(wakes.length, 1);
        assert.deepEqual(wakes[0].result, { status: 200 });
        assert.equal(wakes[0].summary, "first");
        assert.equal(await live.cancel(row.id), false);
    } finally { release.resolve(); await db.close(); }
});
