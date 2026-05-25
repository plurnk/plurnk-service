// Tests for SEND[499] cancellation propagation (SPEC §3.5, §7.7).

import test from "node:test";
import assert from "node:assert/strict";
import type { SendStatement, EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import { openSubscription, setChannelState, findActiveSubscription, closeSubscription } from "../../src/core/ChannelWrite.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { openMigrated, seedEnvelope, makeSchemeCtx } from "./_helpers.ts";

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
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { sessionId: number; runId: number; loopId: number; turnId: number }, statement: SendStatement) =>
    engine.dispatch({ statement, ...env, sequence: 1, origin: "client" });

test("SEND[499] on entry without subscription returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(url("known", "x"), "body"), makeSchemeCtx({ db, sessionId, runId }));
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(499, url("known", "x")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("SEND[499] on nonexistent entry returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(499, url("known", "nope")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("SEND[499] on entry-bearing scheme with foreign subscription returns 501", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await new Known().edit(editStmt(url("known", "x"), "body"), makeSchemeCtx({ db, sessionId, runId }));
        const entryId = r.entryId as number;
        await openSubscription(db, { runId, entryId, scheme: "fake-stream-scheme", handle: "h" });

        const cancelResult = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(499, url("known", "x")));
        assert.equal(cancelResult.status, 501);
    } finally { await db.close(); }
});

test("End-to-end: synthetic streaming scheme — SEND[499] tears down subscription, transitions state, closes record", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const teardownCalls: string[] = [];
        const handles = new Map<string, () => void>();

        const entry = await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({
            session_id: sessionId, scheme: "fakestream", pathname: "feed/x",
        });
        if (entry === undefined) throw new Error("seed entry failed");
        const entryId = entry.id;
        await (db.test_seed_channel as PrepMethod).run({
            entry_id: entryId, name: "data", content: "", mimetype: "text/plain", state: "active",
        });

        const handle = "fake-stream-1";
        handles.set(handle, () => teardownCalls.push(handle));
        const subId = await openSubscription(db, { runId, entryId, scheme: "fakestream", handle });

        class FakeStream {
            static manifest = {
                name: "fakestream", channels: { data: "text/plain" }, defaultChannel: "data",
                category: "data" as const, scope: "session" as const,
                writableBy: ["model" as const, "client" as const], volatile: true, modelVisible: true,
            };
            async send(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<{ status: number }> {
                if (statement.signal !== 499) return { status: 501 };
                const path = statement.path;
                if (path === null || path.kind !== "url") return { status: 400 };
                const e = await (ctx.db.test_get_entry_by_path as PrepMethod).get<{ id: number }>({
                    session_id: ctx.sessionId, scheme: path.scheme, pathname: path.pathname,
                });
                if (e === undefined) return { status: 404 };
                const sub = await findActiveSubscription(ctx.db, { runId: ctx.runId, entryId: e.id });
                if (sub === null) return { status: 404 };
                const cb = handles.get(sub.handle);
                if (cb !== undefined) cb();
                await closeSubscription(ctx.db, { subscriptionId: sub.id, status: 499 });
                await setChannelState(ctx.db, { entryId: e.id, channel: "data", state: "closed" });
                return { status: 200 };
            }
        }

        const schemes = new SchemeRegistry();
        schemes.register("fakestream", new FakeStream());
        const engine = new Engine({ db, schemes });

        const result = await engine.dispatch({
            statement: sendStmt(499, url("fakestream", "feed/x")),
            sessionId, runId, loopId, turnId,
            sequence: 1, origin: "client",
        });

        assert.equal(result.status, 200, "scheme accepts cancel");
        assert.deepEqual(teardownCalls, [handle], "teardown callback fired with subscription handle");

        const sub = await (db.test_get_subscription as PrepMethod).get<{ closed_at: string | null; close_status: number | null }>({ id: subId });
        assert.ok(sub?.closed_at !== null, "subscription marked closed");
        assert.equal(sub?.close_status, 499, "close_status = 499");

        const channelState = (await (db.test_get_channel as PrepMethod).get<{ state: string }>({ entry_id: entryId, name: "data" }))?.state;
        assert.equal(channelState, "closed", "channel state transitioned to closed");

        const active = await findActiveSubscription(db, { runId, entryId });
        assert.equal(active, null, "no active subscription remaining");
    } finally { await db.close(); }
});

test("End-to-end via daemon RPC: op.send with status 499 on entry with no subscription returns 404", async () => {
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
        await db.close();
    }
});
