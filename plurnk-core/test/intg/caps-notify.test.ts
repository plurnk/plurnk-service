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
import type { StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import { openMigrated, insertWorkspace, insertSession } from "./_db.ts";
import { makeSchemeCtx, schemeManifest } from "./_scheme.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
// Wall-clock wait for a condition — the emit's entryId lookup goes through the shared
// SqlRite session, which serializes every test's queries under load, so the wait must be
// measured in real time, not in event-loop turns (a turn count exhausts while queued).
const waitUntil = async (cond: () => boolean, timeoutMs = 10000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
};

test("{§capability-ctx} DbNotifyCaps: streamEvent emits for the resolved entry; absent entry / no notifier → no event", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-notify-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const captured: Array<{ sid: number; payload: StreamEventPayload }> = [];
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, streamEventNotify: (sid, payload) => captured.push({ sid, payload }) });
        const entries = new DbEntryCaps(ctx, "workspace", schemeManifest("workspace"), "");
        const notify = new DbNotifyCaps(ctx, "workspace", "");

        await entries.write("/stream.md", { channels: { body: { content: "data", mimetype: "text/markdown" } } });

        // positive — wait (wall-clock) until the best-effort async emit lands
        notify.streamEvent("/stream.md", "body", "active", 42);
        await waitUntil(() => captured.length >= 1);
        assert.equal(captured.length, 1);
        assert.equal(captured[0].sid, workspaceId);
        assert.equal(captured[0].payload.sessionId, sessionId, "notification identifies the producing session");
        assert.equal(captured[0].payload.channel, "body");
        assert.equal(captured[0].payload.state, "active");
        assert.equal(captured[0].payload.contentLength, 42);
        assert.match(captured[0].payload.target, /workspace:\/\/\/.*stream\.md/);

        // a vanished entry resolves to null → never emits (give the resolve room)
        notify.streamEvent("/missing.md", "body", "active", 1);
        for (let i = 0; i < 30; i++) await tick();
        assert.equal(captured.length, 1);

        // no notifier wired → silent sync no-op, never throws, nothing scheduled
        const noNotifier = new DbNotifyCaps(makeSchemeCtx({ db, workspaceId }), "session", "");
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
        const entries = new DbEntryCaps(notifyCtx, "session", schemeManifest("session"), "");
        await entries.write("/stream.md", {
            channels: { body: { content: "data", mimetype: "text/markdown" } },
        });

        new DbNotifyCaps(notifyCtx, "session", "").streamEvent("/stream.md", "body", "active", 4);
        await waitUntil(() => diagnostics.length === 1, 4000);
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0]?.[1], notifyCause, "the notifier exception remains the diagnostic cause");

        const lookupCause = new Error("lookup failed");
        const failingLookupDb = new Proxy(db, {
            get(target, property) {
                if (property === "crud_find_workspace_entry") {
                    return { get: async () => { throw lookupCause; } };
                }
                return Reflect.get(target, property, target);
            },
        });
        const lookupCtx = makeSchemeCtx({
            db: failingLookupDb,
            workspaceId,
            streamEventNotify: () => { throw new Error("not reached"); },
        });

        new DbNotifyCaps(lookupCtx, "session", "").streamEvent("/stream.md", "body", "active", 4);
        await waitUntil(() => diagnostics.length === 2, 4000);
        assert.equal(diagnostics.length, 2);
        assert.equal(diagnostics[1]?.[1], lookupCause, "the database exception remains the diagnostic cause");
    } finally { await db.close(); }
});
