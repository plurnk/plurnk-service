// Ws engine tests (#468). Hermetic: injected fake socket (no real WebSocket),
// IP-literal targets (net.isIP short-circuits DNS in the guard). The socket's
// close() fires its own `close` listener, mirroring the real WebSocket.

import test from "node:test";
import { strict as assert } from "node:assert";
import Ws from "./Ws.ts";
import {
    Results,
    type SchemeCtx,
    type UrlPath,
    type ReadStatement,
    type SendStatement,
    type KillStatement,
    type EntryCaps,
    type EntryStorageWriteResult,
    type ChannelCaps,
    type TagCaps,
    type NotifyCaps,
    type ProjectionCaps,
    type SubscriptionCaps,
} from "@plurnk/plurnk-schemes";

const PUB = "wss://93.184.216.34/feed"; // public IP literal - skips DNS

interface SocketEvent { data?: unknown; code?: number; reason?: string; message?: string }
const fakeSocket = () => {
    const listeners = new Map<string, (ev: SocketEvent) => void>();
    const sent: string[] = [];
    let closed: { code?: number; reason?: string } | null = null;
    const fire = (type: string, ev: SocketEvent = {}) => listeners.get(type)?.(ev);
    return {
        sent,
        get closed() { return closed; },
        addEventListener(type: string, fn: (ev: SocketEvent) => void) { listeners.set(type, fn); },
        send(data: string) { sent.push(data); },
        close(code?: number, reason?: string) { if (closed !== null) return; closed = { code, reason }; fire("close", { code, reason }); },
        emit: fire,
    };
};

interface CtxOverrides {
    readonly write?: EntryCaps["write"];
    readonly notifyChunk?: SubscriptionCaps["notifyChunk"];
    readonly close?: SubscriptionCaps["close"];
}

const makeCtx = (overrides: CtxOverrides = {}) => {
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let opened: { pathname: string } | null = null;
    let closed: { result: Parameters<SubscriptionCaps["close"]>[0]; summary?: string } | null = null;
    let wrote: string | null = null;
    const localAbort = new AbortController();

    const entries: EntryCaps = {
        operations: {
            async editBatch() { return { status: 501, entryId: null, channel: null }; },
            async read() { return { status: 501, content: null, mimetype: null, channel: null }; },
            async find() { return { status: 501, content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] }; },
            async send() { return { status: 501 }; },
        },
        async read() {
            return Results.failure(
                "scheme:test",
                "entry-not-found",
                404,
                "No entry exists.",
                { entry: null },
            ) as Awaited<ReturnType<EntryCaps["read"]>>;
        },
        async write(pathname, entry, owner) {
            wrote = pathname;
            return overrides.write?.(pathname, entry, owner)
                ?? { status: 201, created: true, entryId: 1 };
        },
        async delete() { return { status: 200 }; },
    };
    const channels: ChannelCaps = {
        async append() { return { status: 200 }; },
        async replace() { return { status: 200 }; },
        async setState() { return { status: 200 }; },
    };
    const tags: TagCaps = {
        async add() { return { status: 200 }; },
        async remove() { return { status: 200 }; },
        async list() { return { status: 200, tags: [] }; },
    };
    const notify: NotifyCaps = { streamEvent() {} };
    const projection: ProjectionCaps = { async readable(content) { return { content, mimetype: "text/markdown" }; } };
    const subscriptions: SubscriptionCaps = {
        async open(pathname) { opened = { pathname }; return localAbort.signal; },
        async notifyChunk(channel, chunk, mimetype) {
            chunks.push({ channel, chunk, mimetype });
            await overrides.notifyChunk?.(channel, chunk, mimetype);
        },
        async close(result, summary) {
            closed = { result, summary };
            await overrides.close?.(result, summary);
        },
    };
    const ctx: SchemeCtx = {
        workspaceId: 1, workerId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries, channels, tags, notify, projection, subscriptions,
    };
    return { ctx, localAbort, inspect: () => ({ chunks, opened, closed, wrote }) };
};

const wss = (raw: string, pathname: string): UrlPath => ({
    kind: "url", raw, scheme: raw.split("://")[0],
    username: null, password: null, hostname: "example.com", port: null,
    pathname, params: {}, fragment: null,
});
const readStmt = (target: UrlPath): ReadStatement => ({ op: "READ", suffix: "READ", signal: null, target, lineMarker: null, body: null, position: { line: 0, column: 0 } });
const sendStmt = (signal: number, target: UrlPath, body?: string): SendStatement => ({ op: "SEND", suffix: "SEND", signal, target, lineMarker: null, body: body === undefined ? null : { raw: body, json: null }, position: { line: 0, column: 0 } });
const killStmt = (target: UrlPath): KillStatement => ({ op: "KILL", suffix: "KILL", signal: null, target, lineMarker: null, body: null, position: { line: 0, column: 0 } });

const flush = () => new Promise((r) => setImmediate(r));

test("manifest: wss scheme - messages channel, plug glyph, requiresWeb, network-volatile", () => {
    assert.equal(Ws.manifest.name, "wss");
    assert.equal(Ws.manifest.defaultChannel, "messages");
    assert.deepEqual(Object.keys(Ws.manifest.channels), ["messages"]);
    assert.equal(Ws.manifest.flags?.requiresWeb, true);
    assert.equal(Ws.manifest.volatile, true);
    assert.equal(Ws.manifest.glyph, "🔌");
    const op = (Ws.manifest.example ?? "").match(/^<<([A-Z]+)\(.+\)::([A-Z]+)$/);
    assert.ok(op, `example must be a well-formed <<OP(…)::OP heredoc, got: ${Ws.manifest.example}`);
    assert.equal(op[1], op[2], "example opener and closer op must match");
    assert.equal(op[1], "READ");
});

test("manifest: documentation is loaded verbatim from docs/wss.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const fromFile = await readFile(new URL("../docs/wss.md", import.meta.url), "utf-8");
    assert.equal(Ws.manifest.documentation, fromFile);
    assert.match(Ws.manifest.documentation ?? "", /^# wss:\/\//);
});

test("READ: inbound frames stream into messages; socket close settles done", async () => {
    const sock = fakeSocket();
    const { ctx, inspect } = makeCtx();
    const p = new Ws(() => sock).read(readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("message", { data: "hello" });
    sock.emit("message", { data: "world" });
    sock.close(1000);
    const r = await p;

    assert.equal(r.status, 102);
    const { chunks, opened, closed, wrote } = inspect();
    assert.equal(wrote, "/feed"); // create-then-subscribe
    assert.equal(opened?.pathname, "/feed");
    assert.deepEqual(chunks.filter((c) => c.channel === "messages").map((c) => c.chunk), ["hello", "world"]);
    assert.ok(chunks.every((c) => c.channel !== "messages" || c.mimetype === "text/plain"));
    assert.equal(closed?.result.status, 200);
    assert.equal(closed?.summary, "ws closed (1000); 2 messages");
});

test("READ: an SSRF target is refused (403) and never connects", async () => {
    let connected = false;
    const { ctx } = makeCtx();
    const r = await new Ws(() => { connected = true; return fakeSocket(); }).read(readStmt(wss("ws://127.0.0.1/x", "/x")), ctx);
    assert.equal(r.status, 403);
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/wss/ssrf-blocked");
    assert.equal(connected, false);
});

test("READ: a connect throw settles error (502), not an unhandled throw", async () => {
    const { ctx, inspect } = makeCtx();
    const r = await new Ws(() => { throw new Error("handshake refused"); }).read(readStmt(wss(PUB, "/feed")), ctx);
    assert.equal(r.status, 502);
    assert.equal(r.problem?.detail, `The WebSocket connection to ${PUB} failed.`);
    assert.equal(r.problem?.stage, "connection");
    assert.equal(r.problem?.retryable, true);
    assert.equal(inspect().closed?.result.status, 502);
    assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.dev/scheme/wss/connect-failed");
});

test("READ preserves an exact seed-write failure without connecting", async () => {
    const failure = Results.failure(
        "scheme:test",
        "storage-read-only",
        503,
        "The entry store is read-only.",
        { created: false, entryId: null },
        { stage: "storage", retryable: false },
    ) as EntryStorageWriteResult;
    let connected = false;
    const { ctx, inspect } = makeCtx({ write: async () => failure });
    const result = await new Ws(() => {
        connected = true;
        return fakeSocket();
    }).read(readStmt(wss(PUB, "/feed")), ctx);
    assert.deepEqual(result, { ...failure, shape: "passthrough" });
    assert.equal(connected, false);
    assert.equal(inspect().opened, null);
});

test("SEND[200]: pushes the body onto the open socket a prior READ opened", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => sock);
    const { ctx } = makeCtx();
    void ws.read(readStmt(wss(PUB, "/feed")), ctx); // registers, promise stays pending (socket open)
    await flush();
    const r = await ws.send(sendStmt(200, wss(PUB, "/feed"), "ping"), ctx);
    assert.equal(r.status, 200);
    assert.deepEqual(sock.sent, ["ping"]);
});

test("SEND[200]: no open socket → 409 (READ opens the connection SEND rides)", async () => {
    const { ctx } = makeCtx();
    const r = await new Ws(() => fakeSocket()).send(sendStmt(200, wss(PUB, "/feed"), "x"), ctx);
    assert.equal(r.status, 409);
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/wss/no-open-socket");
    assert.equal(r.problem?.recovery, "READ the WebSocket URL before sending a message.");
});

test("SEND[200]: a socket send throw becomes a structured transport failure", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => ({
        ...sock,
        send() { throw new Error("raw socket failure"); },
    }));
    const { ctx } = makeCtx();
    void ws.read(readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    const result = await ws.send(sendStmt(200, wss(PUB, "/feed"), "ping"), ctx);
    assert.equal(result.status, 502);
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/wss/send-failed");
    assert.equal(result.problem?.detail, "The WebSocket message could not be sent.");
    assert.equal(result.problem?.stage, "transfer");
});

test("SEND[499]: scheme-level no-op 200 (engine routes teardown to the handle)", async () => {
    const { ctx } = makeCtx();
    const r = await new Ws(() => fakeSocket()).send(sendStmt(499, wss(PUB, "/feed")), ctx);
    assert.equal(r.status, 200);
});

test("SEND: an uninterpreted code → 501", async () => {
    const { ctx } = makeCtx();
    const r = await new Ws(() => fakeSocket()).send(sendStmt(200 + 3, wss(PUB, "/feed"), "x"), ctx);
    assert.equal(r.status, 501);
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/wss/send-status-unsupported");
    assert.equal(r.problem?.requestedStatus, 203);
    assert.equal(r.problem?.stage, "dispatch");
});

test("KILL: closes the open socket and settles the READ", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => sock);
    const { ctx, inspect } = makeCtx();
    const read = ws.read(readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    const r = await ws.kill(killStmt(wss(PUB, "/feed")), ctx);
    assert.equal(r.status, 200);
    assert.deepEqual(sock.closed, { code: 1000, reason: "killed" });
    await read; // KILL's close fired the READ's close listener → resolves
    assert.equal(inspect().closed?.result.status, 200);
});

test("KILL: no open socket → 404", async () => {
    const { ctx } = makeCtx();
    const r = await new Ws(() => fakeSocket()).kill(killStmt(wss(PUB, "/feed")), ctx);
    assert.equal(r.status, 404);
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/wss/no-open-socket");
});

test("KILL: a socket close throw becomes a structured transport failure", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => ({
        ...sock,
        close() { throw new Error("raw socket failure"); },
    }));
    const { ctx } = makeCtx();
    void ws.read(readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    const result = await ws.kill(killStmt(wss(PUB, "/feed")), ctx);
    assert.equal(result.status, 502);
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/wss/close-failed");
    assert.equal(result.problem?.detail, "The WebSocket connection could not be closed.");
});

test("READ: message persistence failure settles with a structured problem", async () => {
    const sock = fakeSocket();
    const { ctx, inspect } = makeCtx({
        notifyChunk: async () => { throw new Error("raw persistence failure"); },
    });
    const read = new Ws(() => sock).read(readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("message", { data: "hello" });
    const result = await read;
    assert.equal(result.status, 500);
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/wss/message-persistence-failed");
    assert.equal(result.problem?.stage, "persistence");
    assert.equal(inspect().closed?.result.problem, result.problem);
});

test("READ: subscription close rejection rejects instead of hanging", async () => {
    const sock = fakeSocket();
    const { ctx } = makeCtx({
        close: async () => { throw new Error("subscription close failed"); },
    });
    const read = new Ws(() => sock).read(readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.close(1000);
    await assert.rejects(read, /subscription close failed/);
});

test("cancel: the composed abort signal closes the socket", async () => {
    const sock = fakeSocket();
    const { ctx, localAbort, inspect } = makeCtx();
    const read = new Ws(() => sock).read(readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    localAbort.abort(); // loop.cancel → onAbort → socket.close → close listener → settle
    await read;
    assert.deepEqual(sock.closed, { code: 1000, reason: "cancelled" });
    assert.equal(inspect().closed?.result.status, 499);
    assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.dev/scheme/wss/cancelled");
});
