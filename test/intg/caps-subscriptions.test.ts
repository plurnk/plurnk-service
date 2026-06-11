// Conformance: the db-backed SubscriptionCaps (keystone PR-2, #180) — the
// streaming open → notifyChunk → close lifecycle a sibling drives, against real
// SQLite: content appends + stream/events, terminal channel state, registry
// close, run wake with the summary, and run-abort → signal + handle cancel.

import test from "node:test";
import assert from "node:assert/strict";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbSubscriptionCaps from "../../src/core/caps/DbSubscriptionCaps.ts";
import type { WakeRunPayload, StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

test("DbSubscriptionCaps: open binds + composes abort, notifyChunk streams, close terminates + wakes", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `caps-sub-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const streamEvents: StreamEventPayload[] = [];
        const wakes: WakeRunPayload[] = [];
        const parentAbort = new AbortController();
        const ctx = makeSchemeCtx({
            db, sessionId, runId, signal: parentAbort.signal,
            streamEventNotify: (_s, e) => streamEvents.push(e),
            wakeRunNotify: (p) => wakes.push(p),
        });
        const entries = new DbEntryCaps(ctx, "exec");
        const subs = new DbSubscriptionCaps(ctx, "exec");

        const seeded = await entries.write("/run", { channels: { stdout: { content: "", mimetype: "text/plain", state: "active" } }, tags: [] });
        const entryId = seeded.entryId as number;

        // open → a live (un-aborted) signal
        let cancelled = false;
        const signal = await subs.open("/run", { cancel: () => { cancelled = true; } });
        assert.equal(signal.aborted, false);

        // notifyChunk → content appends + each fires a stream/event
        await subs.notifyChunk("stdout", "hello ");
        await subs.notifyChunk("stdout", "world");
        assert.equal((await entries.read("/run")).entry?.channels.stdout.content, "hello world");
        assert.ok(streamEvents.length >= 2, "each chunk fired a stream/event");

        // close("done") → channel terminal, registry closed, run woken with the summary
        await subs.close("done", "exit 0; 11 bytes");
        const meta = await (db.channel_meta as PrepMethod).get<{ state: string }>({ entry_id: entryId, channel: "stdout" });
        assert.equal(meta?.state, "closed");
        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].closeStatus, 200);
        assert.equal(wakes[0].summary, "exit 0; 11 bytes");
        assert.equal(wakes[0].target, "exec:///run");

        // a run abort propagates to the subscription signal AND force-cancels the handle
        await entries.write("/run2", { channels: { stdout: { content: "", mimetype: "text/plain" } }, tags: [] });
        const signal2 = await subs.open("/run2", { cancel: () => { cancelled = true; } });
        parentAbort.abort();
        assert.equal(signal2.aborted, true, "run abort propagates to the subscription signal");
        assert.equal(cancelled, true, "run abort force-cancels the sibling handle");

        // open on an absent entry → throws (a subscription needs its entry)
        await assert.rejects(() => subs.open("/missing", { cancel: () => {} }), /no entry/);
    } finally { await db.close(); }
});
