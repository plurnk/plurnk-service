// Tests for SEND[499] cancellation propagation (SPEC §3.5, §7.7).

import test from "node:test";
import assert from "node:assert/strict";
import type { SendStatement, EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import { openSubscription, setChannelState, findActiveSubscription } from "../../src/core/ChannelWrite.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const sendStmt = (status: number, recipient: UrlPath | null = null, body: string | null = null): SendStatement => ({
    op: "SEND", suffix: "", signal: status, path: recipient, lineMarker: null,
    body: body === null ? null : { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const editStmt = (path: UrlPath, body: string | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const env = seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { sessionId: number; runId: number; loopId: number; turnId: number }, statement: SendStatement) =>
    engine.dispatch({ statement, ...env, actionIndex: 0, origin: "client" });

test("SEND[499] on entry without subscription returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit({ db, sessionId, runId, statement: editStmt(url("known", "x"), "body") });
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(499, url("known", "x")));
        assert.equal(r.status, 404);
    } finally { db.close(); }
});

test("SEND[499] on nonexistent entry returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(499, url("known", "nope")));
        assert.equal(r.status, 404);
    } finally { db.close(); }
});

test("SEND[499] on entry-bearing scheme with foreign subscription returns 501", async () => {
    // Edge case: if some other scheme opens a subscription against an
    // entry-bearing path, entry-bearing scheme.send refuses to handle it
    // (subscription is owned by another scheme).
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await new Known().edit({ db, sessionId, runId, statement: editStmt(url("known", "x"), "body") });
        const entryId = r.entryId as number;
        // Simulate foreign-scheme subscription
        openSubscription(db, { runId, entryId, scheme: "fake-stream-scheme", handle: "h" });

        const cancelResult = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(499, url("known", "x")));
        assert.equal(cancelResult.status, 501);
    } finally { db.close(); }
});

test("End-to-end: synthetic streaming scheme — SEND[499] tears down subscription, transitions state, closes record", async () => {
    // Validates the full cancellation contract using an in-test scheme that
    // implements the streaming pattern. Mirrors what sse:// / exec:// will do.

    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        // Set up state for the synthetic scheme
        const teardownCalls: string[] = [];
        const handles = new Map<string, () => void>();

        // Create entry with a streaming channel (active state)
        const entry = db.prepare("INSERT INTO entries (scope, session_id, scheme, pathname) VALUES ('session', ?, 'fakestream', 'feed/x') RETURNING id").get(sessionId) as { id: number };
        const entryId = entry.id;
        db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens, state) VALUES (?, 'data', '', 'text/plain', 0, 'active')").run(entryId);

        // Open subscription with a handle that maps to a teardown callback
        const handle = "fake-stream-1";
        handles.set(handle, () => teardownCalls.push(handle));
        const subId = openSubscription(db, { runId, entryId, scheme: "fakestream", handle });

        // Synthetic scheme handler
        class FakeStream {
            static channels = { data: "text/plain" };
            static defaultChannel = "data";
            async send(ctx: { db: typeof db; statement: SendStatement; sessionId: number; runId: number }): Promise<{ status: number }> {
                if (ctx.statement.signal !== 499) return { status: 501 };
                const path = ctx.statement.path;
                if (path === null || path.kind !== "url") return { status: 400 };
                const e = db.prepare("SELECT id FROM entries WHERE scheme = ? AND pathname = ? AND session_id = ?").get(path.scheme, path.pathname, ctx.sessionId) as { id: number } | undefined;
                if (e === undefined) return { status: 404 };
                const sub = findActiveSubscription(db, { runId: ctx.runId, entryId: e.id });
                if (sub === null) return { status: 404 };
                // Teardown via the stored handle
                const cb = handles.get(sub.handle);
                if (cb !== undefined) cb();
                // Close subscription record + transition channel state
                const { closeSubscription } = await import("../../src/core/ChannelWrite.ts");
                closeSubscription(db, { subscriptionId: sub.id, status: 499 });
                setChannelState(db, { entryId: e.id, channel: "data", state: "closed" });
                return { status: 200 };
            }
        }

        const schemes = new SchemeRegistry();
        schemes.register("fakestream", new FakeStream());
        const engine = new Engine({ db, schemes });

        // Fire SEND[499]
        const result = await engine.dispatch({
            statement: sendStmt(499, url("fakestream", "feed/x")),
            sessionId, runId, loopId, turnId,
            actionIndex: 0, origin: "client",
        });

        assert.equal(result.status, 200, "scheme accepts cancel");
        assert.deepEqual(teardownCalls, [handle], "teardown callback fired with subscription handle");

        // Subscription record closed
        const sub = db.prepare("SELECT closed_at, close_status FROM subscriptions WHERE id = ?").get(subId) as { closed_at: string | null; close_status: number | null };
        assert.ok(sub.closed_at !== null, "subscription marked closed");
        assert.equal(sub.close_status, 499, "close_status = 499");

        // Channel state transitioned
        const channelState = (db.prepare("SELECT state FROM entry_channels WHERE entry_id = ? AND name = 'data'").get(entryId) as { state: string }).state;
        assert.equal(channelState, "closed", "channel state transitioned to closed");

        // findActiveSubscription now returns null
        const active = findActiveSubscription(db, { runId, entryId });
        assert.equal(active, null, "no active subscription remaining");
    } finally { db.close(); }
});

test("End-to-end via daemon RPC: op.send with status 499 on entry with no subscription returns 404", async () => {
    // Higher-level test via op.send RPC; confirms the cancellation flow works
    // through the full wire stack.
    const { WebSocket } = await import("ws");
    const { default: Daemon } = await import("../../src/server/Daemon.ts");

    const db = await openMigrated();
    const daemon = new Daemon({ db });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
    await new Promise<void>((resolve) => { ws.once("open", () => resolve()); });

    const rpcCall = (id: number, method: string, params?: object): Promise<{ result?: { status: number }; error?: { code: number } }> =>
        new Promise((resolve) => {
            const onMessage = (data: Buffer) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === id) { ws.off("message", onMessage); resolve(msg); }
            };
            ws.on("message", onMessage);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });

    try {
        await rpcCall(1, "session.create", { name: "test-499" });
        await rpcCall(2, "op.edit", { path: "known://x", content: "hi" });
        const r = await rpcCall(3, "op.send", { status: 499, recipient: "known://x" });
        assert.equal(r.result?.status, 404, "SEND[499] on entry with no subscription is 404");
    } finally {
        ws.close();
        await daemon.stop();
        db.close();
    }
});
