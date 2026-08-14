// Tests for SEND[499] cancellation propagation (SPEC {§send-dispatch}, {§stream-control}).

import test from "node:test";
import assert from "node:assert/strict";
import type { SendStatement, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import {
    Results,
    type ResolvedEditStatement,
    type RepresentationPreparationRequest,
    type SchemeCtx,
    type StreamSubscription,
} from "@plurnk/plurnk-schemes";
import { openMigrated, seedEnvelope, makeSchemeCtx } from "./_helpers.ts";

const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const sendStmt = (status: number, recipient: UrlPath | null = null, body: string | null = null): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: recipient, lineMarker: null,
    body: body === null ? null : { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const editStmt = (target: UrlPath, body: string | null = null): ResolvedEditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const readStmt = (target: UrlPath): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { workspaceId: number; workerId: number; loopId: number; turnId: number }, statement: SendStatement) =>
    engine.dispatch({ statement, ...env, sequence: 1, origin: "client" });

test("SEND[499] on entry without subscription returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(url("worker", "x"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(499, url("worker", "x")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("SEND[499] on nonexistent entry returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(499, url("worker", "nope")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("SEND[499] on entry-bearing scheme with foreign subscription returns 501", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const r = await new Worker().edit(editStmt(url("worker", "x"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const entryId = r.entryId as number;
        await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "fake-stream-scheme", handle: "h" });

        const cancelResult = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(499, url("worker", "x")));
        assert.equal(cancelResult.status, 501);
    } finally { await db.close(); }
});

test("End-to-end: synthetic streaming scheme — SEND[499] tears down subscription, transitions state, closes record", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
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
                let subscription: StreamSubscription | undefined;
                subscription = await ctx.subscriptions.open(request.pathname, {
                    cancel: async () => {
                        teardownCalls.push(handle);
                        if (subscription === undefined) throw new Error("stream subscription missing");
                        await subscription.close(
                            Results.failure("scheme:teststream", "cancelled", 499, "The stream was cancelled by SEND[499]."),
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
            statement: readStmt(url("fakestream", "/feed/x")),
            workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "client",
        });
        assert.equal(opened.status, 102, "scheme opened the subscription through public capabilities");
        const entry = await db.test_get_entry_by_path.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "fakestream", pathname: "/feed/x",
        });
        if (entry === undefined) throw new Error("stream entry missing");
        const entryId = entry.id;
        const activeBefore = await ChannelWrite.findActiveSubscription(db, { workerId, entryId });
        if (activeBefore === null) throw new Error("subscription missing");
        const subId = activeBefore.id;

        const result = await engine.dispatch({
            statement: sendStmt(499, url("fakestream", "/feed/x")),
            workspaceId, workerId, loopId, turnId,
            sequence: 2, origin: "client",
        });

        assert.equal(result.status, 200, "scheme accepts cancel");
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
        assert.equal(terminal.problem?.type, "https://problems.plurnk.dev/scheme/teststream/cancelled");
        assert.equal(terminal.problem?.detail, "The stream was cancelled by SEND[499].");

        const channelState = (await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "data" }))?.state;
        assert.equal(channelState, "errored", "cancelled content remains readable but is not marked complete");

        const active = await ChannelWrite.findActiveSubscription(db, { workerId, entryId });
        assert.equal(active, null, "no active subscription remaining");
    } finally { await db.close(); }
});

test("End-to-end via daemon RPC: op.send with status 499 on entry with no subscription returns 404", async () => {
    const { default: Daemon } = await import("../../src/server/Daemon.ts");

    const db = await openMigrated();
    const daemon = new Daemon({ db });
    await daemon.start(); // {§rpc}
    const { default: SeamSocket } = await import("./_seam.ts");
    const ws = new SeamSocket(daemon);

    const rpcCall = (id: number, method: string, params?: object): Promise<{ result?: { status: number }; error?: { code: number } }> =>
        new Promise((resolve) => {
            const onMessage = (data: string) => {
                const msg = JSON.parse(data);
                if (msg.id === id) { ws.off("message", onMessage); resolve(msg); }
            };
            ws.on("message", onMessage);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });

    try {
        await rpcCall(1, "workspace.create", { name: "test-499" });
        await rpcCall(2, "op.edit", { target: "worker:///x", content: "hi" });
        const r = await rpcCall(3, "op.send", { status: 499, recipient: "worker:///x" });
        assert.equal(r.result?.status, 404, "SEND[499] on entry with no subscription is 404");
    } finally {
        ws.close();
        await daemon.stop();
        await db.close();
    }
});
