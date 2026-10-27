import test, { describe } from "node:test";
import assert from "node:assert/strict";
import ChannelWrite, { type StreamEventPayload, type WakeSessionPayload } from "../../src/core/ChannelWrite.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import LogBody from "../../src/core/LogBody.ts";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbSubscriptionCaps from "../../src/core/caps/DbSubscriptionCaps.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";
import Log from "../../src/schemes/Log.ts";
import { Results, type RepresentationPreparationRequest, type SchemeCtx, type StreamSubscription } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel, insertLoop, insertTurn, rootWorkspace, seedEnvelope } from "./_db.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, waitForDb } from "./_rpc.ts";
import { type KillStatement, type ReadStatement, type UrlPath, isExecutionOp } from "@plurnk/plurnk-contracts";
import { testExecutors, executionAddress } from "./_execs.ts";
import { killStmt, urlPath, execStmt } from "./_dsl.ts";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSchemeCtx, schemeManifest } from "./_scheme.ts";

describe("ChannelWrite", () => {
// Tests for src/core/ChannelWrite.ts — channel-write helpers + subscription
// registry primitives for streaming schemes.








const seedChannel = async (channelName: string, channelMime: string, initialContent: string, channelState: "static" | "active" | "closed" | "errored" = "active") => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
        workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/x",
    });
    if (entry === undefined) throw new Error("seed entry failed");
    await db.test_seed_channel.run({
        entry_id: entry.id, name: channelName, content: initialContent, mimetype: channelMime, state: channelState,
    });
    return { db, workspaceId, sessionId, entryId: entry.id };
};

test("{§stream} appendToChannel: appends chunk to existing channel content", async () => {
    const { db, entryId, sessionId } = await seedChannel("body", "text/plain", "hello");
    try {
        await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: sessionId, channel: "body", chunk: " world" });
        const row = await db.test_get_channel.get<{ content: string }>({ entry_id: entryId, name: "body" });
        assert.equal(row?.content, "hello world");
    } finally { await db.close(); }
});

test("{§tokenomics-weight-stored-at-write} appendToChannel: every append stores the ruler weight of the complete channel", async () => {
    const { db, entryId, sessionId } = await seedChannel("body", "text/plain", "A😀");
    try {
        await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: sessionId, channel: "body", chunk: "é" });
        const first = await db.test_get_channel.get<{ content: string; weight: number }>({ entry_id: entryId, name: "body" });
        assert.equal(first?.content, "A😀é");
        assert.equal(first?.weight, contentWeight("A😀é"));

        await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: sessionId, channel: "body", chunk: "Z" });
        const second = await db.test_get_channel.get<{ content: string; weight: number }>({ entry_id: entryId, name: "body" });
        assert.equal(second?.content, "A😀éZ");
        assert.equal(second?.weight, contentWeight("A😀éZ"));
    } finally { await db.close(); }
});

test("{§notifications} appendToChannel: invokes notify with producer, current state, and content length", async () => {
    const { db, workspaceId, entryId, sessionId } = await seedChannel("body", "text/plain", "hi", "active");
    try {
        const events: Array<{ workspaceId: number; event: StreamEventPayload }> = [];
        await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: sessionId, channel: "body", chunk: "!", notify: (sid, ev) => events.push({ workspaceId: sid, event: ev }) });
        assert.equal(events.length, 1);
        assert.equal(events[0].workspaceId, workspaceId);
        assert.equal(events[0].event.entryId, entryId);
        assert.equal(events[0].event.sessionId, sessionId);
        assert.equal(events[0].event.channel, "body");
        assert.equal(events[0].event.state, "active");
        assert.equal(events[0].event.contentLength, 3);
    } finally { await db.close(); }
});

test("{§notifications} setChannelState: transitions state and notifies", async () => {
    const { db, entryId, sessionId } = await seedChannel("body", "text/plain", "data", "active");
    try {
        const events: StreamEventPayload[] = [];
        await ChannelWrite.setChannelState(db, { entryId, producerSessionId: sessionId, channel: "body", state: "closed", notify: (_sid, ev) => events.push(ev) });
        const state = (await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "body" }))?.state;
        assert.equal(state, "closed");
        assert.equal(events.length, 1);
        assert.equal(events[0].state, "closed");
    } finally { await db.close(); }
});

test("{§channels} setChannelState: accepts all four valid states", async () => {
    const { db, entryId, sessionId } = await seedChannel("body", "text/plain", "x", "active");
    try {
        for (const s of ["static", "active", "closed", "errored"] as const) {
            await ChannelWrite.setChannelState(db, { entryId, producerSessionId: sessionId, channel: "body", state: s });
            const got = (await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "body" }))?.state;
            assert.equal(got, s);
        }
    } finally { await db.close(); }
});

test("{§subscriptions} openSubscription: inserts a row and returns its id", async () => {
    const { db, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "abc-123" });
        assert.ok(subId > 0);
        const row = await db.test_get_subscription.get<{ scheme: string; handle: string; closed_at: string | null }>({ id: subId });
        assert.equal(row?.scheme, "sse");
        assert.equal(row?.handle, "abc-123");
        assert.equal(row?.closed_at, null);
    } finally { await db.close(); }
});

test("{§exec-lifetime} open streams remain live obligations regardless of their lifetime", async () => {
    const { db, workspaceId, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        const first = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sh", handle: "first" });
        assert.deepEqual(
            await db.session_live_obligations.get({ session_id: sessionId }),
            { streams: 1, sessions: 0 },
            "an open stream holds the session's join",
        );
        const row = await db.test_seed_entry_workspace.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/second",
        });
        if (row === undefined) throw new Error("seed /second failed");
        await db.test_seed_channel.run({
            entry_id: row.id, name: "body", content: "", mimetype: "text/plain", state: "active",
        });
        await ChannelWrite.openSubscription(db, { sessionId, entryId: row.id, scheme: "sh", handle: "second", turnScoped: true });
        await ChannelWrite.closeSubscription(db, { subscriptionId: first, result: { status: 200 } });
        assert.deepEqual(
            await db.session_live_obligations.get({ session_id: sessionId }),
            { streams: 1, sessions: 0 },
            "the turn-scoped stream alone still holds the join after the first stream closes",
        );
    } finally { await db.close(); }
});

test("{§subscriptions} openSubscription: rejects a second active producer for the same entry", async () => {
    const { db, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "h1" });
        await assert.rejects(
            () => ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "h2" }),
            /UNIQUE constraint/i,
        );
    } finally { await db.close(); }
});

test("{§subscriptions}: another workspace Session subscribes, but a foreign workspace cannot", async () => {
    const { db, workspaceId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        const otherSession = await insertSession(db, workspaceId);
        const otherWorkspace = await insertWorkspace(db, "foreign-subscription");
        const foreignSession = await insertSession(db, otherWorkspace);
        await assert.rejects(() => ChannelWrite.openSubscription(db, {
            sessionId: foreignSession, entryId, scheme: "sse", handle: "foreign",
        }), /subscription and resource must share a workspace/);
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            sessionId: otherSession, entryId, scheme: "sse", handle: "shared", source: "log:///1/2/3/sse",
        });
        assert.equal((await ChannelWrite.findActiveSubscription(db, { entryId }))?.id, subscriptionId);
        await assert.rejects(() => db.test_subscription_reassign_source.run({ id: subscriptionId, source: "log:///1/9/3/sse" }),
            /subscription identity is immutable/);
        await assert.rejects(() => db.test_delete_session.run({ id: otherSession }), /subscription identity is immutable/,
            "a causal session cannot disappear while its execution is still active");
        await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });
        await db.test_delete_session.run({ id: otherSession });
        const retained = await db.test_get_subscription.get<{ session_id: number | null; close_status: number }>({ id: subscriptionId });
        assert.equal(retained?.session_id, null);
        assert.equal(retained?.close_status, 200);
    } finally { await db.close(); }
});

test("{§subscriptions} openSubscription: allows new subscription after previous one is closed", async () => {
    const { db, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        const sub1 = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "h1" });
        await ChannelWrite.closeSubscription(db, { subscriptionId: sub1, result: { status: 200 } });
        const sub2 = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "h2" });
        assert.ok(sub2 > sub1);
    } finally { await db.close(); }
});

test("{§subscriptions} closeSubscription: persists the exact result and indexed status", async () => {
    const { db, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "h" });
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

test("{§subscriptions} closeSubscription: idempotent — already-closed subscription is a no-op", async () => {
    const { db, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "h" });
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

test("{§exec-lifetime} findOpenTurnScopedSubscriptionsForSession selects only turn-scoped (<0>) subs; closed ones drop out", async () => {
    const { db, workspaceId, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        // A turn-scoped (`<0>`) sub and an ordinary (unbounded) sub — on different entries, since
        // there's one active sub per entry. Only the turn-scoped one is reaped at pre-turn.
        const scoped = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sh", handle: "scoped", turnScoped: true });
        const e2 = await db.test_seed_entry_workspace.get<{ id: number }>({ workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/y" });
        if (e2 === undefined) throw new Error("seed entry 2 failed");
        await db.test_seed_channel.run({
            entry_id: e2.id,
            name: "body",
            content: "",
            mimetype: "text/plain",
            state: "active",
        });
        const ordinary = await ChannelWrite.openSubscription(db, { sessionId, entryId: e2.id, scheme: "sh", handle: "ordinary" });

        const open = await ChannelWrite.findOpenTurnScopedSubscriptionsForSession(db, sessionId);
        assert.deepEqual(open.map((s) => s.id), [scoped], "only the <0> sub is turn-scoped — the unbounded one is not reaped at pre-turn");
        assert.ok(!open.some((s) => s.id === ordinary), "the unbounded sub is excluded");

        // Once closed (reaped), it drops out — the pre-turn reap is one-shot, never a double-abort.
        await ChannelWrite.closeSubscription(db, {
            subscriptionId: scoped,
            result: Results.failure("scheme:test", "cancelled", 499, "The test stream was cancelled."),
        });
        assert.equal((await ChannelWrite.findOpenTurnScopedSubscriptionsForSession(db, sessionId)).length, 0, "a closed turn-scoped sub is no longer selected");
    } finally { await db.close(); }
});

test("{§subscriptions} findActiveSubscription: returns active sub for the entry", async () => {
    const { db, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "h-abc" });
        const found = await ChannelWrite.findActiveSubscription(db, { entryId });
        assert.ok(found !== null);
        assert.equal(found.id, subId);
        assert.equal(found.scheme, "sse");
        assert.equal(found.handle, "h-abc");
    } finally { await db.close(); }
});

test("{§subscriptions} findActiveSubscription: returns null when nothing active", async () => {
    const { db, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        const subId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "h" });
        await ChannelWrite.closeSubscription(db, { subscriptionId: subId, result: { status: 200 } });
        const found = await ChannelWrite.findActiveSubscription(db, { entryId });
        assert.equal(found, null);
    } finally { await db.close(); }
});

test("{§subscriptions} subscriptions CASCADE on entry delete", async () => {
    const { db, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "h" });
        await db.test_delete_entry.run({ id: entryId });
        const count = (await db.test_count_subscriptions_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("{§db-migrations} subscriptions must open before any settlement fields can be stored", async () => {
    const { db, sessionId, entryId } = await seedChannel("body", "text/plain", "");
    try {
        await assert.rejects(
            () => db.test_invalid_subscription_only_closed_at.run({ session_id: sessionId, entry_id: entryId }),
            /subscription must open before it can settle/,
        );
        await assert.rejects(
            () => db.test_invalid_subscription_only_close_status.run({ session_id: sessionId, entry_id: entryId }),
            /subscription must open before it can settle/,
        );
    } finally { await db.close(); }
});
});

describe("Daemon.stream-event", () => {
// Tests for daemon's stream/event notification. SPEC {§stream} + {§notifications}.







test("{§stream} notifyStreamEvent broadcasts to a workspace's clients, envelope stamped with the scope", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "stream-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");

            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "hello", state: "active" });
            const sessionId = await RuntimeSession.ensure(db, workspaceId);
            daemon.notifyStreamEvent(workspaceId, {
                entryId, sessionId, target: "workspace:///x", channel: "body", state: "active", contentLength: 5, mimetype: "text/markdown",
            });

            assert.equal(captured().length, 1);
            const evt = captured()[0] as { workspaceId: number; entryId: number; sessionId: number; channel: string; state: string; contentLength: number };
            assert.equal(evt.workspaceId, workspaceId, "the envelope carries its workspace scope so multi-workspace clients can route it");
            assert.equal(evt.entryId, entryId);
            assert.equal(evt.sessionId, sessionId);
            assert.equal(evt.channel, "body");
            assert.equal(evt.state, "active");
            assert.equal(evt.contentLength, 5);
        } finally { ws.close(); }
    });
});

test("{§stream} appendToChannel via the daemon's notify callback fires stream/event end-to-end", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "append-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "hi", state: "active" });

            const notify = (sid: number, ev: StreamEventPayload) =>
                daemon.notifyStreamEvent(sid, ev);
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "!", notify });
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "?", notify });

            const events = captured() as Array<{ contentLength: number; target: string }>;
            assert.equal(events.length, 2);
            assert.equal(events[0].contentLength, 3);
            assert.equal(events[1].contentLength, 4);
            assert.equal(events[0].target, "workspace:///x", "stream/event carries the entry's canonical target URI");
        } finally { ws.close(); }
    });
});

test("{§stream} setChannelState end-to-end fires stream/event with state change", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "state-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "done", state: "active" });

            await ChannelWrite.setChannelState(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", state: "closed", notify: (sid, ev) => daemon.notifyStreamEvent(sid, ev) });

            const events = captured() as Array<{ state: string }>;
            assert.equal(events.length, 1);
            assert.equal(events[0].state, "closed");
        } finally { ws.close(); }
    });
});

test("{§stream} stream/event is workspace-scoped — other workspaces don't see it", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aResp = await rpcCall(wsA, 1, "workspace.create", { name: "workspace-A" });
            const bResp = await rpcCall(wsB, 1, "workspace.create", { name: "workspace-B" });
            const workspaceA = (aResp.result as { id: number }).id;
            const workspaceB = (bResp.result as { id: number }).id;

            const aEvents = subscribeNotifications(wsA, "stream/event");
            const bEvents = subscribeNotifications(wsB, "stream/event");

            const entryIdA = await seedEntryWithChannel(db, { workspaceId: workspaceA, content: "hi", state: "active" });
            const sessionIdA = await RuntimeSession.ensure(db, workspaceA);
            daemon.notifyStreamEvent(workspaceA, {
                entryId: entryIdA, sessionId: sessionIdA, target: "workspace:///x", channel: "body", state: "active", contentLength: 2, mimetype: "text/markdown",
            });

            const entryIdB = await seedEntryWithChannel(db, { workspaceId: workspaceB, content: "yo", state: "active" });
            const sessionIdB = await RuntimeSession.ensure(db, workspaceB);
            daemon.notifyStreamEvent(workspaceB, {
                entryId: entryIdB, sessionId: sessionIdB, target: "workspace:///x", channel: "body", state: "active", contentLength: 2, mimetype: "text/markdown",
            });


            const aCaptured = aEvents() as Array<{ entryId: number }>;
            assert.equal(aCaptured.length, 1);
            assert.equal(aCaptured[0].entryId, entryIdA);

            const bCaptured = bEvents() as Array<{ entryId: number }>;
            assert.equal(bCaptured.length, 1);
            assert.equal(bCaptured[0].entryId, entryIdB);
        } finally { wsA.close(); wsB.close(); }
    });
});

test("{§stream} appendToChannel + setChannelState forward the entry coordinate onto stream/event", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "coord-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "hi", state: "active" });

            const notify = (sid: number, ev: StreamEventPayload) =>
                daemon.notifyStreamEvent(sid, ev);
            const coordinate = { loop_seq: 1, turn_seq: 2, sequence: 3 };
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "!", notify, coordinate });
            await ChannelWrite.setChannelState(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", state: "closed", notify, coordinate });

            const events = captured() as Array<{ loop_seq?: number; turn_seq?: number; sequence?: number }>;
            assert.equal(events.length, 2);
            for (const ev of events) {
                assert.equal(ev.loop_seq, 1, "stream/event carries the coordinate as fields, not buried in the URI");
                assert.equal(ev.turn_seq, 2);
                assert.equal(ev.sequence, 3);
            }
        } finally { ws.close(); }
    });
});

test("{§stream} appendToChannel with a mimetype retypes the channel + surfaces it on stream/event", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "retype-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            // Seeded text/markdown (the manifest default); a streaming scheme learns the real type per call.
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "", mimetype: "text/markdown", state: "active" });

            const notify = (sid: number, ev: StreamEventPayload) =>
                daemon.notifyStreamEvent(sid, ev);
            // First chunk carries the now-known per-call type → retype.
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "{", notify, mimetype: "application/json" });
            // A later chunk omits it — the retype must persist (stored, not per-event).
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "}", notify });

            const events = captured() as Array<{ mimetype?: string }>;
            assert.equal(events.length, 2);
            assert.equal(events[0].mimetype, "application/json", "the labelled chunk retypes the channel away from text/markdown + carries it");
            assert.equal(events[1].mimetype, "application/json", "the retype is stored — a later unlabelled chunk still reports it");
        } finally { ws.close(); }
    });
});
});

describe("Exec.kill", () => {
// {§stream-control} A backgrounded host-effect exec is
// addressable by its stamped coordinate and killable via the same controller
// abort loop.cancel rides. This proves the 200 case end-to-end: a real `sleep`
// spawned, killed mid-flight, and the spawn drained — not just the routing.












const killExec = (pathname: string, scheme = "exec"): KillStatement => ({
    metadata: null,
    op: "KILL", aside: null,
    target: {
        kind: "url", raw: `${scheme}://${pathname}`, scheme,
        username: null, password: null, hostname: null, port: null,
        pathname, query: null, fragment: null,
    },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

for (const scheme of ["sh", "exec"]) {
test(`{§stream-control} Engine.dispatch: KILL through ${scheme} aborts a running exec — 200, spawn drained`, async () => {
    const db = await openMigrated();
    try {
        const registry = new SchemeRegistry();
        const engine = new Engine({ db, schemes: registry });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-kill-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "exec kill test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        // Background a long sleep (host effect → proposes 202; accept → spawns).
        const idD = deferred<number>();
        const execPromise = engine.dispatch({
            statement: execStmt(null, "sleep 30"), workspaceId, sessionId, loopId, turnId,
            sequence: 1, origin: "model", onDispatch: (id) => idD.resolve(id),
        });
        const execLogId = await idD.promise;
        engine.resolveProposal(execLogId, { decision: "accept" });
        const started = await execPromise;
        assert.equal(started.status, 200, "host exec should background (200 started)");

        // Recover the stamped exec:/// coordinate from the log row.
        const row = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: execLogId });
        const pathname = (JSON.parse(row?.attrs ?? "{}") as { pathname?: string }).pathname ?? "";
        assert.notEqual(pathname, "", "exec entry must carry a stamped pathname");

        // The spawn is registered + in-flight.
        const exec = registry.get("exec") as unknown as Exec;
        assert.equal(exec.hasActiveSpawns(sessionId), true, "the sleep must be in-flight before KILL");

        // KILL it by coordinate.
        const kill = await engine.dispatch({
            statement: killExec(pathname, scheme), workspaceId, sessionId, loopId, turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200, "KILL on a running exec returns 200");

        // The abort tears the child down; idle() drains the killed spawn.
        await exec.idle();
        assert.equal(exec.hasActiveSpawns(sessionId), false, "the killed spawn must be drained");
    } finally { await db.close(); }
});
}

test("{§stream-control}: KILL on an unknown exec coordinate returns 404", async () => {
    const db = await openMigrated();
    try {
        const registry = new SchemeRegistry();
        const engine = new Engine({ db, schemes: registry });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-kill-404-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "kill 404 test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        // No spawn was ever stamped at this coordinate — exec is model-writable
        // (no 403 confound), so kill() resolves the closed-subscription lookup to 404.
        const r = await engine.dispatch({
            statement: killExec("/sh/9/9/9"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 404, "KILL on a coordinate that was never spawned is 404");
    } finally { await db.close(); }
});

test("{§stream-control}: a KILL error answers in the model's runtime-tag scheme, never the internal exec://", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `exec-kill-canon-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = { db, workspaceId, sessionId, loopId: 0, turnId: 0, writer: "model" as const, signal: undefined, mimetypes: undefined, weigh: (t: string) => t.length };
        const exec = new Exec(undefined, () => { throw new Error("this test materializes nothing"); });
        // {§scheme-operation-dispatch} The authored target names the runtime, not its adapter.
        const notRunning = await exec.kill(killStmt(urlPath("sh", "/3/1/4")), ctx);
        assert.equal(notRunning.status, 404);
        assert.match(notRunning.problem?.detail ?? "", /sh:\/\/\/3\/1\/4/, "error names the model's own sh:/// address");
        assert.doesNotMatch(notRunning.problem?.detail ?? "", /exec:\/\//, "never leaks the internal exec:// scheme");
        const bare = await exec.kill(killStmt(urlPath("exec", "/3/1/4")), ctx);
        assert.match(bare.problem?.detail ?? "", /exec:\/\//, "an explicit internal address retains its own identity");
    } finally { await db.close(); }
});

test("{§stream-control} KILL rejects streams whose terminal state is already durable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `exec-kill-terminal-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = { db, workspaceId, sessionId, loopId: 0, turnId: 0, writer: "model" as const, signal: undefined, mimetypes: undefined, weigh: (t: string) => t.length };
        const exec = new Exec(undefined, () => { throw new Error("this test materializes nothing"); });
        const close = async (pathname: string, result: { status: number; problem?: never } | ReturnType<typeof Results.failure>): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, {
                workspaceId,
                scheme: "sh",
                pathname,
                channel: "stdout",
                content: "",
                mimetype: "text/stream",
            });
            const subscriptionId = await ChannelWrite.openSubscription(db, {
                sessionId,
                entryId,
                scheme: "sh",
                handle: `sh: ${pathname}`,
            });
            await ChannelWrite.closeSubscription(db, { subscriptionId, result });
        };

        await close("/3/1/1", { status: 200 });
        // #757 — a process that already ended satisfies KILL: success with how it ended, no Problem.
        const closed = await exec.kill(killStmt(urlPath("sh", "/3/1/1")), ctx);
        assert.deepEqual(closed, { status: 200, terminalStatus: 200 });

        await close("/3/1/2", Results.failure("executor:sh", "killed", 499, "killed"));
        const killed = await exec.kill(killStmt(urlPath("sh", "/3/1/2")), ctx);
        assert.deepEqual(killed, { status: 200, terminalStatus: 499 });

        const unknown = await exec.kill(killStmt(urlPath("sh", "/3/1/9")), ctx);
        assert.equal(unknown.status, 404, "a stream that never existed is still refused");
    } finally { await db.close(); }
});
});

describe("Exec.streaming", () => {
// Streaming verification: a countdown script emits one line every 0.5s
// for ~3 seconds. The exec scheme's job is to land each chunk in
// entry_channels.content as it arrives — not all at once at close.
//
// This test exercises the time dimension that every other exec test
// glosses over by using `echo` (instant output) or `sleep 30` (no
// output until aborted). Here we verify:
//   1. Channel content grows monotonically over the spawn's lifetime.
//   2. Channel state is "active" during emission, "closed" after exit.
//   3. stream/event notifications fire per chunk (not just at close)
//      with increasing contentLength values, so a daemon client could
//      render a live waterfall.
//   4. The final byte count matches the script's complete output.














const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

test("{§stream} streaming exec: chunks land in the channel as they arrive (not buffered until close)", async () => {
    // 5 lines, 0.5s apart — ~2.5s total. Each line is 2 bytes ("N\n").
    // We sample mid-stream and assert content has GROWN but isn't yet
    // complete, then sample again after idle to assert final state.
    const events: StreamEventPayload[] = [];
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            streamEventNotify: (_workspaceId, event) => events.push(event),
        });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-stream-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "streaming test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(null, "for i in 5 4 3 2 1; do echo $i; sleep 0.5; done"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200, "applyResolution returns 200/started fast — does not block");

        // Find the auto-generated entry id from the log entry's attrs.
        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname,
        });
        assert.ok(entryRow, "exec entry was created at proposal-time, before any output");

        const sampleStdout = async (): Promise<{ content: string; state: string }> => {
            const row = await db.test_get_channel.get<{ content: string; state: string }>({
                entry_id: entryRow.id, name: "stdout",
            });
            return { content: row?.content ?? "", state: row?.state ?? "?" };
        };

        // Sample at T+0 (just after dispatch returned) — channel may be
        // empty or partially populated depending on whether spawn has had
        // a tick yet. The invariant is state=active.
        const t0 = await sampleStdout();
        assert.equal(t0.state, "active", "channel starts in 'active' state during spawn");

        // The first output is visible while the process still runs, and more follows: streaming, never one write at
        // its exit, however fast or slow the host.
        const t1 = await waitForDb(sampleStdout, ({ content, state }) => content.length > 0 || state !== "active");
        assert.equal(t1.state, "active", `stdout shows output while the process still runs; got ${JSON.stringify(t1)}`);
        assert.ok(t1.content.length < 10, `the first output is partial, not the full 10 bytes ("5\\n4\\n3\\n2\\n1\\n"); got ${t1.content.length} bytes`);
        const t2 = await waitForDb(sampleStdout, ({ content }) => content.length > t1.content.length);
        assert.ok(t2.content.length > t1.content.length,
            `content grew monotonically: t1=${t1.content.length} bytes → t2=${t2.content.length} bytes`);

        // Wait for completion.
        await exec.idle();
        const tEnd = await sampleStdout();
        assert.equal(tEnd.content, "5\n4\n3\n2\n1\n", "final stdout is all 5 lines");
        assert.equal(tEnd.state, "closed", "channel transitions active → closed at exit");

        // Stream events: per-chunk while active + state transition at end.
        const chunkEvents = events.filter((e) => e.state === "active" && e.channel === "stdout");
        const closeEvents = events.filter((e) => e.state === "closed" && e.channel === "stdout");
        assert.ok(chunkEvents.length >= 3,
            `expected ≥3 stdout chunk events (one per line, modulo buffering); got ${chunkEvents.length}`);
        // ContentLength must be monotonically non-decreasing across chunk events.
        const lengths = chunkEvents.map((e) => e.contentLength);
        for (let i = 1; i < lengths.length; i++) {
            assert.ok(lengths[i] >= lengths[i - 1],
                `contentLength should be monotonically non-decreasing across chunk events; got ${lengths.join(", ")}`);
        }
        assert.equal(closeEvents.length, 1, "exactly one state=closed event for stdout");
        assert.equal(closeEvents[0].contentLength, 10, "close event reports final byte count (5 lines × 2 bytes)");
        for (const event of events) {
            assert.equal(event.target, `sh://${pathname}`);
            assert.deepEqual([event.loop_seq, event.turn_seq, event.sequence], [1, 1, 1],
                "clients receive the numeric coordinate independently of the executor leaf");
        }
    } finally { await db.close(); }
});

test("{§subscriptions} streaming exec: subscription stays open during emission, closes after exit", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-stream-sub-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "subscription lifecycle");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(null, "for i in 3 2 1; do echo $i; sleep 0.4; done"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;

        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname,
        });

        // Mid-stream, once output shows while the process runs: the subscription is still open (closed_at IS NULL).
        const streaming = await waitForDb(async () => db.test_get_channel.get<{ content: string; state: string }>({ entry_id: entryRow!.id, name: "stdout" }),
            (row) => (row?.content.length ?? 0) > 0 || (row !== undefined && row.state !== "active"));
        assert.equal(streaming?.state, "active", "the process still runs");
        const midSub = await db.test_get_subscription_by_entry.get<{
            closed_at: string | null; close_status: number | null;
        }>({ session_id: sessionId, entry_id: entryRow!.id });
        assert.equal(midSub?.closed_at, null, "subscription is alive during emission");
        assert.equal(midSub?.close_status, null);

        // After completion: subscription closes at 200.
        await exec.idle();
        const endSub = await db.test_get_subscription_by_entry.get<{
            closed_at: string | null; close_status: number | null; close_result: string | null;
        }>({ session_id: sessionId, entry_id: entryRow!.id });
        assert.ok(endSub?.closed_at, "subscription closed after spawn exit");
        assert.equal(endSub?.close_status, 200, "clean exit closes subscription at 200");
        assert.deepEqual(JSON.parse(endSub?.close_result ?? "null"), { status: 200, exitCode: 0 });
    } finally { await db.close(); }
});

test("{§exec-target-routing} streaming exec: the workspace catalog picks up partial channel content between samples", async () => {
    // The workspace catalog (engine_list_workspace_entries, its
    // source) reads channels.content LIVE — so each turn build sees
    // whatever bytes have landed by that moment. This proves the model
    // would observe partial output across turn boundaries (rather than
    // seeing nothing until close).
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-stream-idx-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "catalog mid-stream");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(null, "for i in 4 3 2 1; do echo $i; sleep 0.4; done"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        await dispatchPromise;

        const execStdout = async (): Promise<Array<{ scheme: string; pathname: string; content: string }>> => {
            // Read the exec entry's stdout channel from the workspace catalog
            // (engine_list_workspace_entries, the source behind the catalog):
            // one row per (entry, channel) with the channel's LIVE content.
            // Streaming is a channel property — partial bytes must be observable
            // mid-stream regardless of how they're later rendered.
            const rows = await db.engine_list_workspace_entries.all<{
                scheme: string; pathname: string;
                channel: string; content: string;
            }>({ workspace_id: workspaceId });
            return rows
                .filter((r) => r.scheme === "sh" && r.channel === "stdout")
                .map((r) => ({ scheme: r.scheme, pathname: r.pathname, content: r.content }));
        };

        // Mid-stream snapshot of the catalog, once its first output shows.
        const mid = await waitForDb(execStdout, (rows) => rows.length === 1 && rows[0].content.length > 0);
        assert.equal(mid.length, 1, "exec stdout visible in the catalog mid-stream");
        assert.ok(mid[0].content.length > 0, `catalog reflects partial content; got "${mid[0].content}"`);
        assert.ok(mid[0].content.length < 8, "partial content < full 8 bytes (4\\n3\\n2\\n1\\n)");

        // After completion.
        await exec.idle();
        const end = await execStdout();
        assert.equal(end[0].content, "4\n3\n2\n1\n");
    } finally { await db.close(); }
});

// {§exec-target-routing}: accepting an empty-body file target runs the file
// without changing its authored mode.
test("{§exec-target-routing} an empty-body 0o644 script target survives acceptance and runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exec-file-target-"));
    const db = await openMigrated();
    try {
        await writeFile(join(dir, "demo_greet.sh"), "echo greetings-from-file-target\n", { mode: 0o644 });
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-file-target-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, dir);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "run the script");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: { metadata: null, runtime: "sh", aside: null, target: { kind: "local", raw: "demo_greet.sh" }, lineMarker: null, body: "", position: { line: 1, column: 1 } },
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        const result = await dispatchPromise;
        assert.ok(result.status < 400, `the empty-body file target survives accept (got ${result.status} ${JSON.stringify(result)})`);

        const exec = schemes.get("exec") as Exec;
        await exec.idle();
        // Follow the output address recorded by the accepted operation.
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname: new URL(await executionAddress(db, turnId)).pathname });
        assert.ok(entryRow, "the sh exec entry exists at the returned address");
        const ch = await db.test_get_channel.get<{ content: string }>({ entry_id: entryRow.id, name: "stdout" });
        assert.match(ch?.content ?? "", /greetings-from-file-target/, "the script ran and its stdout arrived");
        const mode = (await stat(join(dir, "demo_greet.sh"))).mode & 0o777;
        assert.equal(mode, 0o644, "transient exec: the mode is untouched — no chmod magic");
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});
});

describe("KILL.stream", () => {
// KILL cancels a live stream ({§stream-control}).










const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const readStmt = (target: UrlPath): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null, target, lineMarker: null, matcher: null, body: null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { workspaceId: number; sessionId: number; loopId: number; turnId: number }, statement: KillStatement) =>
    engine.dispatch({ statement, ...env, sequence: 1, origin: "client" });
test("{§stream-control} KILL on nonexistent entry returns 404", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(url("workspace", "nope")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});
test("{§pinned-wording-core} End-to-end: synthetic streaming scheme — KILL tears down subscription, transitions state, closes record", async () => {
    const { db, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        const teardownCalls: string[] = [];
        const handle = "fake-stream-1";

        class FakeStream {
            static manifest = {
                name: "fakestream", channels: { data: "text/plain" }, defaultChannel: "data",
                category: "data" as const,
                writableBy: ["model" as const, "client" as const], volatile: true, modelVisible: true,
            };
            async prepareRepresentation(
                request: RepresentationPreparationRequest,
                ctx: SchemeCtx,
            ): Promise<{ status: number }> {
                const path = request.target;
                if (path === null || path.kind !== "url") {
                    return Results.failure(
                        "scheme:teststream",
                        "target-required",
                        400,
                        "The stream fixture requires a URL target.",
                        {},
                        { stage: "validate", retryable: false },
                    );
                }
                await ctx.entries.write(request.pathname, {
                    channels: { data: { content: "", mimetype: "text/plain", state: "active" } },
                });
                const subscription: StreamSubscription = await ctx.subscriptions.open(request.pathname, {
                    cancel: async () => {
                        teardownCalls.push(handle);
                        await subscription.close(
                            Results.failure("scheme:teststream", "cancelled", 499, "The stream was cancelled by KILL."),
                            "cancelled by KILL",
                        );
                    },
                });
                return { status: 102 };
            }
        }

        const schemes = new SchemeRegistry();
        schemes.register("fakestream", new FakeStream());
        const engine = new Engine({ db, schemes });
        const opened = await engine.dispatch({
            statement: readStmt(url("fakestream", "/feed/x")),
            workspaceId, sessionId, loopId, turnId,
            sequence: 1, origin: "client",
        });
        assert.equal(opened.status, 102, "scheme opened the subscription through public capabilities");
        const entry = await db.test_get_entry_by_path.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "fakestream", pathname: "/feed/x",
        });
        if (entry === undefined) throw new Error("stream entry missing");
        const entryId = entry.id;
        const activeBefore = await ChannelWrite.findActiveSubscription(db, { entryId });
        if (activeBefore === null) throw new Error("subscription missing");
        const subId = activeBefore.id;

        const result = await engine.dispatch({
            statement: killStmt(url("fakestream", "/feed/x")),
            workspaceId, sessionId, loopId, turnId,
            sequence: 2, origin: "client",
        });

        assert.equal(result.status, 200, "scheme accepts cancel");
        assert.equal(result.receipt, undefined, "stream cancellation is not a textual edit");
        assert.equal(LogBody.resolve({ op: "KILL", tx: "", rx: result }).content, "");
        assert.deepEqual(teardownCalls, [handle], "teardown callback fired with subscription handle");

        const sub = await db.test_get_subscription.get<{
            closed_at: string | null;
            close_status: number | null;
            close_result: string | null;
        }>({ id: subId });
        assert.ok(sub?.closed_at !== null, "subscription marked closed");
        assert.equal(sub?.close_status, 499, "close_status = 499");
        const terminal = JSON.parse(sub?.close_result ?? "null") as {
            status?: number;
            problem?: { type?: string; status?: number; detail?: string };
        };
        assert.equal(terminal.status, 499);
        assert.equal(terminal.problem?.status, 499);
        assert.equal(terminal.problem?.type, "https://problems.plurnk.xyz/scheme/teststream/cancelled");
        assert.equal(terminal.problem?.detail, "The stream was cancelled by KILL."); // {§pinned-wording-core}

        const channelState = (await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "data" }))?.state;
        assert.equal(channelState, "errored", "cancelled content remains readable but is not marked complete");

        const active = await ChannelWrite.findActiveSubscription(db, { entryId });
        assert.equal(active, null, "no active subscription remaining");
    } finally { await db.close(); }
});
});

describe("caps-subscriptions", () => {
// Conformance: plurnk-schemes {§scheme-subscriptions} — the streaming
// open → notifyChunk → close lifecycle an extension drives against real
// SQLite: content appends + stream/events, terminal channel state, registry
// close, session wake with the summary, and session abort → signal + handle cancel.










test("{§channels} DbSubscriptionCaps: open binds + composes abort, notifyChunk streams, close terminates + wakes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-sub-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const streamEvents: StreamEventPayload[] = [];
        const wakes: WakeSessionPayload[] = [];
        const parentAbort = new AbortController();
        const ctx = makeSchemeCtx({
            db, workspaceId, sessionId, signal: parentAbort.signal,
            streamEventNotify: (_s, e) => streamEvents.push(e),
            wakeSessionNotify: (p) => wakes.push(p),
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
        assert.ok(streamEvents.every((event) => event.sessionId === sessionId), "stream updates identify their producer");

        // close(result) → channel terminal, exact result persisted, session woken with the summary
        await subs.close({ status: 200 }, "exit 0; 11 bytes");
        assert.ok(streamEvents.every((event) => event.channel === "stdout"), "only the selected default channel is published");
        const meta = await db.channel_meta.get<{ state: string }>({ entry_id: entryId, channel: "stdout" });
        assert.equal(meta?.state, "closed");
        assert.equal((await entries.read("/run")).entry?.channels.stdout.state, "closed");
        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].sessionId, sessionId, "the lifecycle wake still targets the invoking session");
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

        // a session abort propagates to the subscription signal AND force-cancels the handle
        await entries.write("/run2", { channels: {
            stdout: { content: "", mimetype: "text/plain", state: "active" },
        } });
        const signal2 = await subs.open("/run2", { cancel: () => { cancelCalls += 1; } });
        const entry2 = await entries.read("/run2");
        assert.equal(entry2.status, 200);
        const sub2 = await db.find_open_subscriptions_for_session.all<{ id: number }>({ session_id: sessionId });
        const cancelledId = sub2.at(-1)?.id;
        assert.ok(cancelledId !== undefined);
        parentAbort.abort();
        assert.equal(signal2.aborted, true, "session abort propagates to the subscription signal");
        assert.equal(cancelCalls, 1, "session abort force-cancels the sibling handle");
        assert.equal(await liveSubscriptions.cancel(cancelledId), true);
        assert.equal(cancelCalls, 1, "the registry reap coalesces with signal cancellation");
        const cancelledResult = Results.failure("scheme:exec", "cancelled", 499, "The session cancelled the stream.");
        await subs.close(cancelledResult, "session cancelled");
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

test("{§subscriptions} notification failure after durable close still releases ownership and wakes the session", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `close-notify-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const failure = new Error("fixture notification failure");
        const wakes: WakeSessionPayload[] = [];
        const ctx = makeSchemeCtx({
            db, workspaceId, sessionId,
            streamEventNotify: () => { throw failure; }, wakeSessionNotify: (event) => wakes.push(event),
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
test(`{§subscriptions} failed durable closure can retry settlement without recancelling the producer (prior cancellation: ${cancelledBeforeClose})`, async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `close-retry-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const wakes: WakeSessionPayload[] = [];
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, wakeSessionNotify: (event) => wakes.push(event) });
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
        assert.equal((await db.find_open_subscriptions_for_session.all({ session_id: sessionId })).length, 1);
        assert.equal(await live.cancel(row.id), true);
        assert.equal((await db.find_open_subscriptions_for_session.all({ session_id: sessionId })).length, 0);
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

test("{§subscriptions} concurrent close and cancellation share the first terminal outcome and one wake", async (t) => {
    const db = await openMigrated();
    const release = Promise.withResolvers<void>();
    try {
        const workspaceId = await insertWorkspace(db, `close-concurrent-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const wakes: WakeSessionPayload[] = [];
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, wakeSessionNotify: (event) => wakes.push(event) });
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
});

describe("contract-streaming", () => {
// Contract coverage for SPEC {§stream} (stream model) + {§notifications} (notifications).
// One test per zero-coverage anchor, each driven against its REAL vehicle:
//   - {§subscriptions}  : Engine KILL routing through the subscription registry to
//             the owning scheme (synthetic streaming scheme, the same pattern
//             SEND.499.test.ts proves for the entry-bearing 501 case).
//   - {§stream}  : a live streaming exec emits many chunks but writes ONE log row.
//   - {§stream}  : the single engine-level cap (100 MiB / channel) — and nothing else.
//   - {§stream}  : daemon fires stream/event per chunk as channel content grows.
//   - {§stream}    : engine has no transaction / connection-lifecycle surface; schemes
//             own connection lifecycle, channels are static storage to the engine.
//   - {§notifications} : stream/event fires on a state TRANSITION (not just content growth),
//             metadata-only payload.














const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// {§subscriptions} — The subscription registry maps (workspaceId, entryId) → scheme + handle
// so KILL routes cancellation to the OWNING scheme, which tears down via
// the stored handle. We register a synthetic streaming scheme that owns its
// subscription; dispatching KILL through the Engine must reach that
// scheme's send(), resolve the registry to the stored handle, fire teardown
// with that exact handle, and close the registry row at 499.
test("{§pinned-wording-core} KILL resolves the registry to the owning scheme + stored handle and tears down", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, turnId } = await seedEnvelope(
            db,
            `sub-route-${crypto.randomUUID()}`,
            { producer: "client" },
        );

        const HANDLE = "fake-stream-handle-7";
        const teardownByHandle: string[] = [];

        class FakeStream {
            static manifest = {
                name: "fakestream", channels: { data: "text/plain" }, defaultChannel: "data",
                category: "data" as const,
                writableBy: ["model" as const, "client" as const], volatile: true, modelVisible: true,
            };
            async prepareRepresentation(
                request: RepresentationPreparationRequest,
                ctx: SchemeCtx,
            ): Promise<{ status: number }> {
                const path = request.target;
                if (path === null || path.kind !== "url") {
                    return Results.failure(
                        "scheme:fakestream",
                        "target-required",
                        400,
                        "The stream fixture requires a URL target.",
                        {},
                        { stage: "validate", retryable: false },
                    );
                }
                await ctx.entries.write(request.pathname, {
                    channels: { data: { content: "partial", mimetype: "text/plain", state: "active" } },
                });
                const subscription: StreamSubscription = await ctx.subscriptions.open(request.pathname, {
                    cancel: async () => {
                        teardownByHandle.push(HANDLE);
                        await subscription.close(
                            Results.failure("scheme:fakestream", "cancelled", 499, "The stream was cancelled by KILL."),
                            "cancelled by KILL",
                        );
                    },
                });
                return { status: 102 };
            }
        }

        const schemes = new SchemeRegistry();
        schemes.register("fakestream", new FakeStream());
        const engine = new Engine({ db, schemes });
        const opened = await engine.dispatch({
            statement: {
                metadata: null,
                op: "READ", aside: null, target: urlPath("fakestream", "/feed/x"),
                lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
            },
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(opened.status, 102, "the public extension opened its subscription");
        const entry = await db.test_get_entry_by_path.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "fakestream", pathname: "/feed/x",
        });
        if (entry === undefined) throw new Error("stream entry missing");
        const entryId = entry.id;
        const activeBefore = await ChannelWrite.findActiveSubscription(db, { entryId });
        if (activeBefore === null) throw new Error("subscription missing");
        const subId = activeBefore.id;

        const result = await engine.dispatch({
            statement: killStmt(urlPath("fakestream", "/feed/x")),
            workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "client",
        });

        assert.equal(result.status, 200, "owning scheme accepted the cancel");
        assert.deepEqual(teardownByHandle, [HANDLE], "registry routed teardown to the stored handle");

        const sub = await db.test_get_subscription.get<{
            closed_at: string | null;
            close_status: number | null;
            close_result: string | null;
        }>({ id: subId });
        assert.ok(sub?.closed_at !== null, "subscription registry row marked closed");
        assert.equal(sub?.close_status, 499, "registry row closed at 499");
        const terminal = JSON.parse(sub?.close_result ?? "null") as {
            status?: number;
            problem?: { type?: string; status?: number; detail?: string };
        };
        assert.equal(terminal.status, 499);
        assert.equal(terminal.problem?.status, 499);
        assert.equal(terminal.problem?.type, "https://problems.plurnk.xyz/scheme/fakestream/cancelled");
        assert.equal(terminal.problem?.detail, "The stream was cancelled by KILL."); // {§pinned-wording-core}
        assert.equal(await ChannelWrite.findActiveSubscription(db, { entryId }), null, "no active subscription remains");

        const channel = await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "data" });
        assert.equal(channel?.state, "errored", "channel transitioned active → errored on cancellation");
    } finally { await db.close(); }
});

test("{§stream} a public streaming READ returns its 102 row before detached subscription work settles", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, turnId } = await seedEnvelope(
            db,
            `detached-sub-${crypto.randomUUID()}`,
            { producer: "client" },
        );
        let subscription: StreamSubscription | undefined;

        class DetachedStream {
            static manifest = {
                name: "detached", channels: { data: "text/plain" }, defaultChannel: "data",
                category: "data" as const,
                writableBy: ["model" as const, "client" as const], volatile: true, modelVisible: true,
            };
            async prepareRepresentation(
                request: RepresentationPreparationRequest,
                ctx: SchemeCtx,
            ): Promise<{ status: number }> {
                if (request.target.kind !== "url") throw new Error("detached fixture requires a URL");
                await ctx.entries.write(request.pathname, {
                    channels: { data: { content: "", mimetype: "text/plain", state: "active" } },
                });
                subscription = await ctx.subscriptions.open(request.pathname, { cancel() {} });
                return { status: 102 };
            }
        }

        const schemes = new SchemeRegistry();
        schemes.register("detached", new DetachedStream());
        const engine = new Engine({ db, schemes });
        const opened = await engine.dispatch({
            statement: {
                metadata: null,
                op: "READ", aside: null, target: urlPath("detached", "/feed"),
                lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
            },
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(opened.status, 102);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: turnId });
        assert.deepEqual(
            rows.map(({ op, status_rx }) => ({ op, status_rx })),
            [{ op: "READ", status_rx: 102 }],
            "the initial observation is durable before retained work proceeds",
        );
        if (subscription === undefined) throw new Error("detached subscription missing");

        await subscription.notifyChunk("data", "after-return", "text/plain");
        await subscription.close({ status: 200 }, "detached complete");

        const entry = await db.test_get_entry_by_path.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "detached", pathname: "/feed",
        });
        if (entry === undefined) throw new Error("detached stream entry missing");
        const channel = await db.test_get_channel.get<{ content: string; state: string }>({
            entry_id: entry.id,
            name: "data",
        });
        assert.deepEqual(
            channel === undefined ? undefined : { content: channel.content, state: channel.state },
            { content: "after-return", state: "closed" },
        );
        assert.equal(await ChannelWrite.findActiveSubscription(db, { entryId: entry.id }), null);
    } finally {
        await db.close();
    }
});

// {§stream} — Channels are the source of truth for chunk content; the log captures
// lifecycle ONLY (open/close), never one row per chunk. A real streaming exec
// emits ≥5 stdout chunks (one per line) yet produces exactly ONE execution log row,
// resolved at status 200 — proving chunks live on the channel, not in the log.
test("{§stream} multi-chunk exec writes ONE lifecycle log row, not one per chunk", async () => {
    const db = await openMigrated();
    try {
        const chunkEvents: Array<{ channel: string; state: string }> = [];
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            streamEventNotify: (_sid, ev) => chunkEvents.push({ channel: ev.channel, state: ev.state }),
        });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `log-lifecycle-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "lifecycle-only");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idD = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(null, "for i in 5 4 3 2 1; do echo $i; sleep 0.2; done"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idD.resolve(id),
        });
        const logEntryId = await idD.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();

        // Many stdout chunk events fired (content grew per line)...
        const stdoutChunks = chunkEvents.filter((e) => e.channel === "stdout" && e.state === "active");
        assert.ok(stdoutChunks.length >= 5, `≥5 stdout chunk events (content grew per line); got ${stdoutChunks.length}`);

        // ...but the log holds exactly ONE execution row for this turn — the lifecycle
        // event — never one row per chunk.
        const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: turnId });
        const execRows = rows.filter((r) => isExecutionOp(r.op));
        assert.equal(execRows.length, 1, "exactly one execution log row regardless of chunk count");
        assert.equal(rows.length, 1, "no per-chunk log rows accumulated for the turn");

        const logRow = await db.test_get_log_entry_by_id.get<{ status_rx: number; state: string }>({ id: logEntryId });
        assert.equal(logRow?.status_rx, 200, "lifecycle row resolved at 200 (graceful close)");
        assert.equal(logRow?.state, "resolved", "lifecycle row in resolved state");
    } finally { await db.close(); }
});

// {§stream} — ONE engine-level constraint: 100 MiB (104857600 chars) per channel
// body, enforced by CHECK on entry_channels.content. Over-cap → SQLITE_CONSTRAINT.
// And NOTHING else is capped: a write well under the cap (1 MiB here) is stored
// verbatim, un-truncated/un-throttled — the engine doesn't impose any smaller limit.
test("{§stream} 100 MiB channel-body CHECK rejects over-cap; engine caps nothing below it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `cap-${crypto.randomUUID()}`);
        const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/cap",
        });
        const entryId = entry!.id;

        const CAP = 104857600;

        // Over the cap by one char → the single engine constraint fires.
        await assert.rejects(
            () => db.test_seed_channel.run({
                entry_id: entryId, name: "toobig", content: "a".repeat(CAP + 1),
                mimetype: "text/plain", state: "static",
            }),
            /CHECK constraint failed/,
            "104857601-char body rejected by the 100 MiB cap",
        );

        // Well under the cap → stored verbatim. The engine throttles/truncates
        // nothing below 100 MiB. Seed an empty channel and append into it.
        const oneMiB = "x".repeat(1024 * 1024);
        await db.test_seed_channel.run({
            entry_id: entryId, name: "under", content: "", mimetype: "text/plain", state: "active",
        });
        await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "under", chunk: oneMiB });
        await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "under", chunk: oneMiB });
        const stored = await db.test_get_channel.get<{ content: string }>({ entry_id: entryId, name: "under" });
        assert.equal(stored?.content.length, 2 * 1024 * 1024, "2 MiB stored verbatim — no engine cap below 100 MiB");
    } finally { await db.close(); }
});

// {§stream} — The daemon emits stream/event when channel content CHANGES, so clients
// render live waterfalls without polling. Driving appendToChannel with the
// daemon's notify callback must fire one event PER chunk (not just at close),
// each carrying the new (growing) contentLength.
test("{§stream} daemon fires stream/event per chunk with growing contentLength", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "chunk-fire" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "", state: "active" });

            const notify = (sid: number, ev: StreamEventPayload) =>
                daemon.notifyStreamEvent(sid, ev);
            // Three separate chunks → three separate events, fired AS content grows.
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "aa", notify });
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "bbb", notify });
            await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "c", notify });

            const events = captured() as Array<{ entryId: number; channel: string; state: string; contentLength: number }>;
            assert.equal(events.length, 3, "one stream/event per chunk (not just at close)");
            assert.deepEqual(events.map((e) => e.contentLength), [2, 5, 6], "contentLength grows monotonically per chunk");
            assert.ok(events.every((e) => e.entryId === entryId && e.channel === "body" && e.state === "active"),
                "each event targets the active body channel");
        } finally { ws.close(); }
    });
});

// {§stream} — No engine-level transaction abstraction; schemes own connection
// lifecycle. Structural: the Engine exposes dispatch and turn orchestration but NO
// connection/transaction surface (begin/commit/rollback/open/close). And
// to the engine, channels are static storage — content arrives by a scheme
// calling appendToChannel directly, with zero engine brokering.
test("{§db-durability} engine has no connection/transaction surface; channel growth is scheme-direct", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // The engine offers no transaction/connection lifecycle methods —
        // those belong to schemes (SPEC {§db-durability}: "Scheme-handler invocation
        // (connections, subprocesses, fetch)" + "Stream AbortController lifecycle").
        for (const forbidden of ["beginTransaction", "commit", "rollback", "openConnection", "closeConnection", "subscribe", "transaction"]) {
            assert.equal(
                typeof (engine as unknown as Record<string, unknown>)[forbidden], "undefined",
                `engine must not expose a '${forbidden}' lifecycle method`,
            );
        }
        // What it DOES expose is turn/dispatch orchestration only.
        assert.equal(typeof engine.dispatch, "function", "engine orchestrates via dispatch");
        assert.equal(typeof engine.runTurn, "function", "engine orchestrates via runTurn");

        // Channel content is static storage from the engine's view: a scheme
        // grows it by calling appendToChannel directly — the engine is not in
        // the loop, there is no transaction to open/commit.
        const { workspaceId } = await seedEnvelope(db, `no-tx-${crypto.randomUUID()}`);
        const entryId = await seedEntryWithChannel(db, { workspaceId, content: "", state: "active" });
        await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "chunk-1" });
        await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: await RuntimeSession.ensure(db, workspaceId), channel: "body", chunk: "chunk-2" });
        const row = await db.test_get_channel.get<{ content: string; state: string }>({ entry_id: entryId, name: "body" });
        assert.equal(row?.content, "chunk-1chunk-2", "content accumulated by scheme-direct appends, no engine transaction");
        assert.equal(row?.state, "active", "engine treats the growing channel as plain static storage");
    } finally { await db.close(); }
});

// {§notifications} — stream/event fires on a STATE TRANSITION (the other arm of "channel
// content grows OR state transitions"), and the payload is metadata-only:
// { entryId, channel, state, contentLength } — the new state, the existing
// content length, and never any content body.
test("{§stream} state transition fires metadata-only stream/event with new state", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "state-change" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "stream/event");
            // Pre-existing content so we can assert contentLength is carried, not recomputed-from-chunk.
            const entryId = await seedEntryWithChannel(db, { workspaceId, content: "finished", state: "active" });

            const notify = (sid: number, ev: StreamEventPayload) =>
                daemon.notifyStreamEvent(sid, ev);
            const producerSessionId = await RuntimeSession.ensure(db, workspaceId);
            await ChannelWrite.setChannelState(db, { entryId, producerSessionId, channel: "body", state: "closed", notify });

            const events = captured() as Array<Record<string, unknown>>;
            assert.equal(events.length, 1, "state transition fires exactly one stream/event");
            const evt = events[0];
            assert.equal(evt.entryId, entryId);
            assert.equal(evt.channel, "body");
            assert.equal(evt.state, "closed", "carries the NEW state (active → closed)");
            assert.equal(evt.contentLength, "finished".length, "carries the existing content length (8)");
            assert.equal(evt.target, "workspace:///x", "carries the entry's canonical target URI");
            assert.equal(evt.sessionId, producerSessionId, "carries the causal actor without an entry-owner axis");
            // Metadata only — never the content body.
            assert.deepEqual(Object.keys(evt).toSorted(), ["channel", "contentLength", "entryId", "mimetype", "sessionId", "state", "target", "workspaceId"], "payload is metadata-only; no content field");
        } finally { ws.close(); }
    });
});
});

describe("exec-kill-scope-subscription", () => {
// {§subscriptions} — scoped log KILL is projection-only; it must
// NOT cancel a live stream's subscription. A streaming exec, body-suppressed mid-stream,
// keeps emitting and closes on its own exit, never on the scoped KILL.













const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

test("{§subscriptions} scoped KILL on a streaming exec's log row keeps the subscription live", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-fold-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "fold keeps stream");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(null, "for i in 4 3 2 1; do echo $i; sleep 0.4; done"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;

        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });

        // Mid-stream, once output shows while the process runs: KILL the exec's log row body (log:///1/1/1 <1,-1>) —
        // render-only curation.
        const streaming = await waitForDb(async () => db.test_get_channel.get<{ content: string; state: string }>({ entry_id: entryRow!.id, name: "stdout" }),
            (row) => (row?.content.length ?? 0) > 0 || (row !== undefined && row.state !== "active"));
        assert.equal(streaming?.state, "active", "the process still runs");
        const scoped = await new Log().kill(killStmt(urlPath("log", "/1/1/1"), { marks: [1, -1] }), makeSchemeCtx({ db, workspaceId, sessionId, loopId, turnId, writer: "model" }));
        assert.equal(scoped.status, 200, "a scoped KILL of the exec log row succeeds");

        // The subscription is STILL open — scoped KILL touched body visibility, not the registry.
        const midSub = await db.test_get_subscription_by_entry.get<{ closed_at: string | null }>({ session_id: sessionId, entry_id: entryRow!.id });
        assert.equal(midSub?.closed_at, null, "scoped KILL did not cancel the live subscription");

        // The stream runs to its own completion, closing 200 (never 499 from the scoped KILL).
        await exec.idle();
        const endSub = await db.test_get_subscription_by_entry.get<{ closed_at: string | null; close_status: number | null }>({ session_id: sessionId, entry_id: entryRow!.id });
        assert.ok(endSub?.closed_at, "subscription closes on the spawn's own exit");
        assert.equal(endSub?.close_status, 200, "clean 200 exit, not a 499 cancellation");
    } finally { await db.close(); }
});
});
