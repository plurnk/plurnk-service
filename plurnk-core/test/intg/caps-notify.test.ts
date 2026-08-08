// Conformance: plurnk-schemes {§capability-ctx} and core
// {§notifications-stream-event-on-channel-change} — streamEvent
// resolves the entry and fires a stream/event with the right payload; a vanished
// entry resolves to null → no event; no notifier wired → silent no-op.
//
// streamEvent is sync but emits best-effort async (the payload's entryId needs a
// db lookup), so the positive case polls until the event lands; the negatives
// give the resolve room and assert nothing fired.

import test from "node:test";
import assert from "node:assert/strict";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbNotifyCaps from "../../src/core/caps/DbNotifyCaps.ts";
import Owner from "../../src/core/Owner.ts";
import type { StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, schemeManifest } from "./_helpers.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
// Wall-clock wait for a condition — the emit's entryId lookup goes through the shared
// SqlRite worker, which serializes every test's queries under load, so the wait must be
// measured in real time, not in event-loop turns (a turn count exhausts while queued).
const waitUntil = async (cond: () => boolean, timeoutMs = 10000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
};

test("DbNotifyCaps: streamEvent emits for the resolved entry; absent entry / no notifier → no event", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-notify-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ownerId = await Owner.commonsId(db, workspaceId);
        const captured: Array<{ sid: number; payload: StreamEventPayload }> = [];
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, streamEventNotify: (sid, payload) => captured.push({ sid, payload }) });
        const entries = new DbEntryCaps(ctx, "worker", schemeManifest("worker"));
        const notify = new DbNotifyCaps(ctx, "worker");

        await entries.write("/stream.md", { channels: { body: { content: "data", mimetype: "text/markdown" } }, tags: [] });

        // positive — wait (wall-clock) until the best-effort async emit lands
        notify.streamEvent("/stream.md", "body", "active", 42);
        await waitUntil(() => captured.length >= 1);
        assert.equal(captured.length, 1);
        assert.equal(captured[0].sid, workspaceId);
        assert.equal(captured[0].payload.workerId, ownerId, "notification carries the stored entry owner, not the invoking worker");
        assert.notEqual(captured[0].payload.workerId, workerId);
        assert.equal(captured[0].payload.channel, "body");
        assert.equal(captured[0].payload.state, "active");
        assert.equal(captured[0].payload.contentLength, 42);
        assert.match(captured[0].payload.target, /worker:\/\/\/.*stream\.md/);

        // a vanished entry resolves to null → never emits (give the resolve room)
        notify.streamEvent("/missing.md", "body", "active", 1);
        for (let i = 0; i < 30; i++) await tick();
        assert.equal(captured.length, 1);

        // no notifier wired → silent sync no-op, never throws, nothing scheduled
        const noNotifier = new DbNotifyCaps(makeSchemeCtx({ db, workspaceId }), "worker");
        assert.doesNotThrow(() => noNotifier.streamEvent("/stream.md", "body", "active", 1));
        for (let i = 0; i < 5; i++) await tick();
        assert.equal(captured.length, 1);
    } finally { await db.close(); }
});

test("{§notifications-stream-event-failure-isolation} lookup and notifier failures are diagnosed with their cause", async (t) => {
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-notify-failure-${crypto.randomUUID()}`);
        const notifyCause = new Error("notifier failed");
        const notifyCtx = makeSchemeCtx({
            db,
            workspaceId,
            streamEventNotify: () => { throw notifyCause; },
        });
        const entries = new DbEntryCaps(notifyCtx, "worker", schemeManifest("worker"));
        await entries.write("/stream.md", {
            channels: { body: { content: "data", mimetype: "text/markdown" } },
            tags: [],
        });

        new DbNotifyCaps(notifyCtx, "worker").streamEvent("/stream.md", "body", "active", 4);
        await waitUntil(() => diagnostics.length === 1, 4000);
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0]?.[1], notifyCause, "the notifier exception remains the diagnostic cause");

        const lookupCause = new Error("lookup failed");
        const failingLookupDb = new Proxy(db as unknown as object, {
            get(target, property) {
                if (property === "crud_find_workspace_entry") {
                    return { get: async () => { throw lookupCause; } };
                }
                return Reflect.get(target, property, target) as unknown;
            },
        }) as Db;
        const lookupCtx = makeSchemeCtx({
            db: failingLookupDb,
            workspaceId,
            streamEventNotify: () => { throw new Error("not reached"); },
        });

        new DbNotifyCaps(lookupCtx, "worker").streamEvent("/stream.md", "body", "active", 4);
        await waitUntil(() => diagnostics.length === 2, 4000);
        assert.equal(diagnostics.length, 2);
        assert.equal(diagnostics[1]?.[1], lookupCause, "the database exception remains the diagnostic cause");
    } finally { await db.close(); }
});
