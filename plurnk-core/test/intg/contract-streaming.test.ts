// Contract coverage for SPEC {§stream} (stream model) + {§notifications} (notifications).
// One test per zero-coverage anchor, each driven against its REAL vehicle:
//   - {§subscriptions}  : Engine SEND[499] routing through the subscription registry to
//             the owning scheme (synthetic streaming scheme, the same pattern
//             SEND.499.test.ts proves for the entry-bearing 501 case).
//   - {§no-chunk-rows}  : a live streaming exec emits many chunks but writes ONE log row.
//   - {§stream-constraints}  : the single engine-level cap (100 MiB / channel) — and nothing else.
//   - {§live-updates}  : daemon fires stream/event per chunk as channel content grows.
//   - {§stream}    : engine has no transaction / connection-lifecycle surface; schemes
//             own connection lifecycle, channels are static storage to the engine.
//   - {§notifications} : stream/event fires on a state TRANSITION (not just content growth),
//             metadata-only payload.

import test from "node:test";
import assert from "node:assert/strict";
import type { ReadStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import ChannelWrite, { type StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import { Results, type SchemeCtx, type StreamSubscription } from "@plurnk/plurnk-schemes";
import {
    openMigrated, seedEnvelope, seedEntryWithChannel,
    insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors,
} from "./_helpers.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";
import { urlPath, sendStmt, execStmt } from "./_dsl.ts";
import Owner from "../../src/core/Owner.ts";

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// {§subscriptions} — The subscription registry maps (workspaceId, entryId) → scheme + handle
// so SEND[499] routes cancellation to the OWNING scheme, which tears down via
// the stored handle. We register a synthetic streaming scheme that owns its
// subscription; dispatching SEND[499] through the Engine must reach that
// scheme's send(), resolve the registry to the stored handle, fire teardown
// with that exact handle, and close the registry row at 499.
test("SEND[499] resolves the registry to the owning scheme + stored handle and tears down", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, turnId } = await seedEnvelope(db, `sub-route-${crypto.randomUUID()}`);

        const HANDLE = "fake-stream-handle-7";
        const teardownByHandle: string[] = [];

        class FakeStream {
            static manifest = {
                name: "fakestream", channels: { data: "text/plain" }, defaultChannel: "data",
                category: "data" as const,
                writableBy: ["model" as const, "client" as const], volatile: true, modelVisible: true,
            };
            async read(statement: ReadStatement, ctx: SchemeCtx): Promise<{ status: number }> {
                const path = statement.target;
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
                await ctx.entries.write(path.pathname, {
                    channels: { data: { content: "partial", mimetype: "text/plain", state: "active" } },
                    tags: [],
                });
                let subscription: StreamSubscription | undefined;
                subscription = await ctx.subscriptions.open(path.pathname, {
                    cancel: async () => {
                        teardownByHandle.push(HANDLE);
                        if (subscription === undefined) throw new Error("stream subscription missing");
                        await subscription.close(
                            Results.failure("scheme:fakestream", "cancelled", 499, "The stream was cancelled by SEND[499]."),
                            "cancelled by SEND[499]",
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
                op: "READ", suffix: "", signal: null, target: urlPath("fakestream", "/feed/x"),
                lineMarker: null, body: null, position: { line: 1, column: 1 },
            },
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(opened.status, 102, "the public plugin opened its subscription");
        const entry = await db.test_get_entry_by_path.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "fakestream", pathname: "/feed/x",
        });
        if (entry === undefined) throw new Error("stream entry missing");
        const entryId = entry.id;
        const activeBefore = await ChannelWrite.findActiveSubscription(db, { workerId, entryId });
        if (activeBefore === null) throw new Error("subscription missing");
        const subId = activeBefore.id;

        const result = await engine.dispatch({
            statement: sendStmt(499, urlPath("fakestream", "/feed/x")),
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "client",
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
        assert.equal(terminal.problem?.type, "https://problems.plurnk.dev/scheme/fakestream/cancelled");
        assert.equal(terminal.problem?.detail, "The stream was cancelled by SEND[499].");
        assert.equal(await ChannelWrite.findActiveSubscription(db, { workerId, entryId }), null, "no active subscription remains");

        const channel = await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "data" });
        assert.equal(channel?.state, "errored", "channel transitioned active → errored on cancellation");
    } finally { await db.close(); }
});

test("a public streaming READ returns its 102 row before detached subscription work settles", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, turnId } = await seedEnvelope(db, `detached-sub-${crypto.randomUUID()}`);
        let subscription: StreamSubscription | undefined;

        class DetachedStream {
            static manifest = {
                name: "detached", channels: { data: "text/plain" }, defaultChannel: "data",
                category: "data" as const,
                writableBy: ["model" as const, "client" as const], volatile: true, modelVisible: true,
            };
            async read(statement: ReadStatement, ctx: SchemeCtx): Promise<{ status: number }> {
                const target = statement.target;
                if (target === null || target.kind !== "url") throw new Error("detached fixture requires a URL");
                await ctx.entries.write(target.pathname, {
                    channels: { data: { content: "", mimetype: "text/plain", state: "active" } },
                    tags: [],
                });
                subscription = await ctx.subscriptions.open(target.pathname, { cancel() {} });
                return { status: 102 };
            }
        }

        const schemes = new SchemeRegistry();
        schemes.register("detached", new DetachedStream());
        const engine = new Engine({ db, schemes });
        const opened = await engine.dispatch({
            statement: {
                op: "READ", suffix: "", signal: null, target: urlPath("detached", "/feed"),
                lineMarker: null, body: null, position: { line: 1, column: 1 },
            },
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
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
        assert.equal(await ChannelWrite.findActiveSubscription(db, { workerId, entryId: entry.id }), null);
    } finally {
        await db.close();
    }
});

// {§no-chunk-rows} — Channels are the source of truth for chunk content; the log captures
// lifecycle ONLY (open/close), never one row per chunk. A real streaming exec
// emits ≥5 stdout chunks (one per line) yet produces exactly ONE EXEC log row,
// resolved at status 200 — proving chunks live on the channel, not in the log.
test("multi-chunk exec writes ONE lifecycle log row, not one per chunk", async () => {
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
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "lifecycle-only");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idD = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt("sh", "for i in 5 4 3 2 1; do echo $i; sleep 0.2; done"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idD.resolve(id),
        });
        const logEntryId = await idD.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();
        await flush();

        // Many stdout chunk events fired (content grew per line)...
        const stdoutChunks = chunkEvents.filter((e) => e.channel === "stdout" && e.state === "active");
        assert.ok(stdoutChunks.length >= 5, `≥5 stdout chunk events (content grew per line); got ${stdoutChunks.length}`);

        // ...but the log holds exactly ONE EXEC row for this turn — the lifecycle
        // event — never one row per chunk.
        const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: turnId });
        const execRows = rows.filter((r) => r.op === "EXEC");
        assert.equal(execRows.length, 1, "exactly one EXEC log row regardless of chunk count");
        assert.equal(rows.length, 1, "no per-chunk log rows accumulated for the turn");

        const logRow = await db.test_get_log_entry_by_id.get<{ status_rx: number; state: string }>({ id: logEntryId });
        assert.equal(logRow?.status_rx, 200, "lifecycle row resolved at 200 (graceful close)");
        assert.equal(logRow?.state, "resolved", "lifecycle row in resolved state");
    } finally { await db.close(); }
});

// {§stream-constraints} — ONE engine-level constraint: 100 MiB (104857600 chars) per channel
// body, enforced by CHECK on entry_channels.content. Over-cap → SQLITE_CONSTRAINT.
// And NOTHING else is capped: a write well under the cap (1 MiB here) is stored
// verbatim, un-truncated/un-throttled — the engine doesn't impose any smaller limit.
test("100 MiB channel-body CHECK rejects over-cap; engine caps nothing below it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `cap-${crypto.randomUUID()}`);
        const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
            workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: "/cap",
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
        await ChannelWrite.appendToChannel(db, { entryId, channel: "under", chunk: oneMiB });
        await ChannelWrite.appendToChannel(db, { entryId, channel: "under", chunk: oneMiB });
        const stored = await db.test_get_channel.get<{ content: string }>({ entry_id: entryId, name: "under" });
        assert.equal(stored?.content.length, 2 * 1024 * 1024, "2 MiB stored verbatim — no engine cap below 100 MiB");
    } finally { await db.close(); }
});

// {§live-updates} — The daemon emits stream/event when channel content CHANGES, so clients
// render live waterfalls without polling. Driving appendToChannel with the
// daemon's notify callback must fire one event PER chunk (not just at close),
// each carrying the new (growing) contentLength.
test("daemon fires stream/event per chunk with growing contentLength", async () => {
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
            await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "aa", notify });
            await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "bbb", notify });
            await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "c", notify });
            await flush();

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
test("engine has no connection/transaction surface; channel growth is scheme-direct", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // The engine offers no transaction/connection lifecycle methods —
        // those belong to schemes (SPEC {§sql-ts-boundary}: "Scheme-handler invocation
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
        await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "chunk-1" });
        await ChannelWrite.appendToChannel(db, { entryId, channel: "body", chunk: "chunk-2" });
        const row = await db.test_get_channel.get<{ content: string; state: string }>({ entry_id: entryId, name: "body" });
        assert.equal(row?.content, "chunk-1chunk-2", "content accumulated by scheme-direct appends, no engine transaction");
        assert.equal(row?.state, "active", "engine treats the growing channel as plain static storage");
    } finally { await db.close(); }
});

// {§notifications} — stream/event fires on a STATE TRANSITION (the other arm of "channel
// content grows OR state transitions"), and the payload is metadata-only:
// { entryId, channel, state, contentLength } — the new state, the existing
// content length, and never any content body.
test("state transition fires metadata-only stream/event with new state", async () => {
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
            await ChannelWrite.setChannelState(db, { entryId, channel: "body", state: "closed", notify });
            await flush();

            const events = captured() as Array<Record<string, unknown>>;
            assert.equal(events.length, 1, "state transition fires exactly one stream/event");
            const evt = events[0];
            assert.equal(evt.entryId, entryId);
            assert.equal(evt.channel, "body");
            assert.equal(evt.state, "closed", "carries the NEW state (active → closed)");
            assert.equal(evt.contentLength, "finished".length, "carries the existing content length (8)");
            assert.equal(evt.target, "worker:///x", "carries the entry's canonical target URI");
            // Metadata only — never the content body.
            assert.deepEqual(Object.keys(evt).toSorted(), ["channel", "contentLength", "entryId", "mimetype", "state", "target", "workspaceId"], "payload is metadata-only (identity/state/length/mimetype + workspace scope); no content field");
        } finally { ws.close(); }
    });
});
