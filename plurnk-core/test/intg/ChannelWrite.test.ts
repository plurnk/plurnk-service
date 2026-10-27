import test, { describe } from "node:test";
import assert from "node:assert/strict";
import ChannelWrite, { type StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { Results } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel, insertLoop, insertTurn, rootWorkspace } from "./_db.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, waitForDb } from "./_rpc.ts";
import { type KillStatement } from "@plurnk/plurnk-contracts";
import { testExecutors, executionAddress } from "./_execs.ts";
import { killStmt, urlPath, execStmt } from "./_dsl.ts";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


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

test("{§tokenomics} appendToChannel: every append stores the ruler weight of the complete channel", async () => {
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

