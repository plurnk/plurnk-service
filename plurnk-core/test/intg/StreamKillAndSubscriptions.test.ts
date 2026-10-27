import test, { describe } from "node:test";
import assert from "node:assert/strict";
import ChannelWrite, { type StreamEventPayload, type WakeSessionPayload } from "../../src/core/ChannelWrite.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import LogBody from "../../src/core/LogBody.ts";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbSubscriptionCaps from "../../src/core/caps/DbSubscriptionCaps.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";
import Log from "../../src/schemes/Log.ts";
import { Results, type RepresentationPreparationRequest, type SchemeCtx, type StreamSubscription } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel, insertLoop, insertTurn, seedEnvelope } from "./_db.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, waitForDb } from "./_rpc.ts";
import { type KillStatement, type ReadStatement, type UrlPath, isExecutionOp } from "@plurnk/plurnk-contracts";
import { testExecutors } from "./_execs.ts";
import { killStmt, urlPath, execStmt } from "./_dsl.ts";
import { makeSchemeCtx, schemeManifest } from "./_scheme.ts";


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
test("{§operation-results} End-to-end: synthetic streaming scheme — KILL tears down subscription, transitions state, closes record", async () => {
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
        assert.equal(terminal.problem?.detail, "The stream was cancelled by KILL."); // {§operation-results}

        const channelState = (await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "data" }))?.state;
        assert.equal(channelState, "errored", "cancelled content remains readable but is not marked complete");

        const active = await ChannelWrite.findActiveSubscription(db, { entryId });
        assert.equal(active, null, "no active subscription remaining");
    } finally { await db.close(); }
});
});

describe("caps-subscriptions", () => {
// Conformance: plurnk-schemes {§capability-ctx} — the streaming
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
        await signal.notifyChunk("stdout", "hello ");
        await signal.notifyChunk("stderr", "diagnostic");
        await signal.notifyChunk("stdout", "world");
        assert.equal((await entries.read("/run")).entry?.channels.stdout.content, "hello world");
        assert.equal((await entries.read("/run")).entry?.channels.stderr.content, "diagnostic", "unpublished auxiliary content is still durable");
        assert.ok(streamEvents.length >= 2, "each chunk fired a stream/event");
        assert.ok(streamEvents.every((event) => event.sessionId === sessionId), "stream updates identify their producer");

        // close(result) → channel terminal, exact result persisted, session woken with the summary
        await signal.close({ status: 200 }, "exit 0; 11 bytes");
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
        const mixedSub = await subs.open("/mixed", { cancel: () => {} });
        const bodyFailure = Results.failure("scheme:exec", "body-failed", 500, "The default body failed.");
        await assert.rejects(
            () => mixedSub.close(bodyFailure, "bad override", { missing: { status: 200 } }),
            /subscription channel result violates the channel producer contract/,
        );
        assert.equal((await entries.read("/mixed")).entry?.channels.stdout.state, "active");
        await mixedSub.close(bodyFailure, "body failed", { stderr: { status: 200 } });
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
        await signal2.close(cancelledResult, "session cancelled");
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
test("{§operation-results} KILL resolves the registry to the owning scheme + stored handle and tears down", async () => {
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
        assert.equal(terminal.problem?.detail, "The stream was cancelled by KILL."); // {§operation-results}
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

