// Conformance: the db-backed SubscriptionCaps (keystone PR-2, #180) — the
// streaming open → notifyChunk → close lifecycle a sibling drives, against real
// SQLite: content appends + stream/events, terminal channel state, registry
// close, run wake with the summary, and run-abort → signal + handle cancel.

import test from "node:test";
import assert from "node:assert/strict";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbSubscriptionCaps from "../../src/core/caps/DbSubscriptionCaps.ts";
import type { WakeWorkerPayload, StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, schemeManifest } from "./_helpers.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";

test("DbSubscriptionCaps: open binds + composes abort, notifyChunk streams, close terminates + wakes", async () => {
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
        const entries = new DbEntryCaps(ctx, "exec", schemeManifest("exec", { stdout: "text/plain", stderr: "text/plain" }, "stdout"));
        const liveSubscriptions = new LiveSubscriptions();
        const subs = new DbSubscriptionCaps(ctx, "exec", liveSubscriptions);

        const seeded = await entries.write("/run", { channels: {
            stdout: { content: "", mimetype: "text/plain", state: "active" },
            stderr: { content: "", mimetype: "text/plain", state: "active" },
        }, tags: [] });
        const entryId = seeded.entryId as number;

        // open → a live (un-aborted) signal
        let cancelCalls = 0;
        const signal = await subs.open("/run", { cancel: () => { cancelCalls += 1; } }, { publishedChannel: "stdout" });
        assert.equal(signal.aborted, false);
        const subscription = await (db.find_active_subscription as PrepMethod).get<{ id: number }>({ worker_id: workerId, entry_id: entryId });
        const publication = await (db.test_subscription_published_channel as PrepMethod).get<{ published_channel: string | null }>({ id: subscription?.id });
        assert.equal(publication?.published_channel, "stdout", "the model-facing selection persists through the completion wake");

        // notifyChunk → content appends + each fires a stream/event
        await subs.notifyChunk("stdout", "hello ");
        await subs.notifyChunk("stderr", "diagnostic");
        await subs.notifyChunk("stdout", "world");
        assert.equal((await entries.read("/run")).entry?.channels.stdout.content, "hello world");
        assert.equal((await entries.read("/run")).entry?.channels.stderr.content, "diagnostic", "unpublished auxiliary content is still durable");
        assert.ok(streamEvents.length >= 2, "each chunk fired a stream/event");

        // close("done") → channel terminal, registry closed, run woken with the summary
        await subs.close("done", "exit 0; 11 bytes");
        assert.ok(streamEvents.every((event) => event.channel === "stdout"), "only the selected default channel is published");
        const meta = await (db.channel_meta as PrepMethod).get<{ state: string }>({ entry_id: entryId, channel: "stdout" });
        assert.equal(meta?.state, "closed");
        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].closeStatus, 200);
        assert.equal(wakes[0].summary, "exit 0; 11 bytes");
        assert.equal(wakes[0].target, "exec:///run");

        // a worker abort propagates to the subscription signal AND force-cancels the handle
        await entries.write("/run2", { channels: { stdout: { content: "", mimetype: "text/plain" } }, tags: [] });
        const signal2 = await subs.open("/run2", { cancel: () => { cancelCalls += 1; } });
        const entry2 = await entries.read("/run2");
        assert.equal(entry2.status, 200);
        const sub2 = await (db.find_open_subscriptions_for_worker as PrepMethod).all<{ id: number }>({ worker_id: workerId });
        const cancelledId = sub2.at(-1)?.id;
        assert.ok(cancelledId !== undefined);
        parentAbort.abort();
        assert.equal(signal2.aborted, true, "run abort propagates to the subscription signal");
        assert.equal(cancelCalls, 1, "run abort force-cancels the sibling handle");
        assert.equal(await liveSubscriptions.cancel(cancelledId), true);
        assert.equal(cancelCalls, 1, "the registry reap coalesces with signal cancellation");
        await subs.close("cancelled", "worker cancelled");
        const cancelledRow = await (db.test_get_subscription as PrepMethod).get<{ close_status: number }>({ id: cancelledId });
        assert.equal(cancelledRow?.close_status, 499, "cancelled settlement is durable 499");

        // open on an absent entry → throws (a subscription needs its entry)
        await assert.rejects(() => subs.open("/missing", { cancel: () => {} }), /no entry/);
    } finally { await db.close(); }
});
