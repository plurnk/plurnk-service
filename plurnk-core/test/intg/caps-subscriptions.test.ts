// Conformance: plurnk-schemes {§scheme-subscriptions} — the streaming
// open → notifyChunk → close lifecycle a plugin drives against real
// SQLite: content appends + stream/events, terminal channel state, registry
// close, worker wake with the summary, and worker abort → signal + handle cancel.

import test from "node:test";
import assert from "node:assert/strict";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbSubscriptionCaps from "../../src/core/caps/DbSubscriptionCaps.ts";
import type { WakeWorkerPayload, StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, schemeManifest } from "./_helpers.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";
import { Results } from "@plurnk/plurnk-schemes";

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
        const subscription = await db.find_active_subscription.get<{ id: number }>({ worker_id: workerId, entry_id: entryId });
        const publication = await db.test_subscription_published_channel.get<{ published_channel: string | null }>({ id: subscription?.id });
        assert.equal(publication?.published_channel, "stdout", "the model-facing selection persists through the completion wake");

        // notifyChunk → content appends + each fires a stream/event
        await subs.notifyChunk("stdout", "hello ");
        await subs.notifyChunk("stderr", "diagnostic");
        await subs.notifyChunk("stdout", "world");
        assert.equal((await entries.read("/run")).entry?.channels.stdout.content, "hello world");
        assert.equal((await entries.read("/run")).entry?.channels.stderr.content, "diagnostic", "unpublished auxiliary content is still durable");
        assert.ok(streamEvents.length >= 2, "each chunk fired a stream/event");

        // close(result) → channel terminal, exact result persisted, worker woken with the summary
        await subs.close({ status: 200 }, "exit 0; 11 bytes");
        assert.ok(streamEvents.every((event) => event.channel === "stdout"), "only the selected default channel is published");
        const meta = await db.channel_meta.get<{ state: string }>({ entry_id: entryId, channel: "stdout" });
        assert.equal(meta?.state, "closed");
        assert.equal((await entries.read("/run")).entry?.channels.stdout.state, "closed");
        assert.equal(wakes.length, 1);
        assert.deepEqual(wakes[0].result, { status: 200 });
        assert.equal(wakes[0].summary, "exit 0; 11 bytes");
        assert.equal(wakes[0].target, "exec:///run");

        // A producer may preserve successfully acquired auxiliary evidence when
        // the default body fails; overrides are exact and validated before writes.
        await entries.write("/mixed", { channels: {
            stdout: { content: "", mimetype: "text/plain", state: "active" },
            stderr: { content: "evidence", mimetype: "text/plain", state: "active" },
        }, tags: [] });
        await subs.open("/mixed", { cancel: () => {} });
        const bodyFailure = Results.failure("scheme:exec", "body-failed", 500, "The default body failed.");
        await assert.rejects(
            () => subs.close(bodyFailure, "bad override", { missing: "closed" }),
            /unknown channel state override missing/,
        );
        assert.equal((await entries.read("/mixed")).entry?.channels.stdout.state, "active");
        await subs.close(bodyFailure, "body failed", { stderr: "closed" });
        const mixed = await entries.read("/mixed");
        assert.equal(mixed.entry?.channels.stdout.state, "errored");
        assert.equal(mixed.entry?.channels.stderr.state, "closed");

        // a worker abort propagates to the subscription signal AND force-cancels the handle
        await entries.write("/run2", { channels: {
            stdout: { content: "", mimetype: "text/plain", state: "active" },
        }, tags: [] });
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
