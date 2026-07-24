// Ws engine tests (#468). Hermetic: injected fake socket (no real WebSocket),
// IP-literal targets (net.isIP short-circuits DNS in the guard). The socket's
// close() fires its own `close` listener, mirroring the real WebSocket.

import test from "node:test";
import { strict as assert } from "node:assert";
import Ws from "./Ws.ts";
import type {
    SchemeCtx,
    UrlPath,
    ReadStatement,
    SendStatement,
    KillStatement,
    EntryCaps,
    ChannelCaps,
    TagCaps,
    NotifyCaps,
    ProjectionCaps,
    SubscriptionCaps,
    CrossSchemeCaps,
} from "@plurnk/plurnk-schemes";

const PUB = "wss://93.184.216.34/feed"; // public IP literal — skips DNS

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

const makeCtx = () => {
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let opened: { pathname: string } | null = null;
    let closed: { reason: string; outcome?: string } | null = null;
    let wrote: string | null = null;
    const localAbort = new AbortController();

    const entries: EntryCaps = {
        async read() { return { status: 404, entry: null }; },
        async write(pathname) { wrote = pathname; return { status: 201, created: true, entryId: 1 }; },
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
        async notifyChunk(channel, chunk, mimetype) { chunks.push({ channel, chunk, mimetype }); },
        async close(reason, outcome) { closed = { reason, outcome }; },
    };
    const crossScheme: CrossSchemeCaps = { _deferred: "see plurnk-service#180 — designed when first cross-scheme COPY/MOVE forces the FROM/TO shape" };
    const ctx: SchemeCtx = {
        workspaceId: 1, workerId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries, channels, tags, notify, projection, subscriptions, crossScheme,
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

test("manifest: wss scheme — messages channel, 🔌, requiresWeb, network-volatile", () => {
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
    assert.equal(closed?.reason, "done");
    assert.equal(closed?.outcome, "ws closed (1000); 2 messages");
});

test("READ: an SSRF target is refused (403) and never connects", async () => {
    let connected = false;
    const { ctx } = makeCtx();
    const r = await new Ws(() => { connected = true; return fakeSocket(); }).read(readStmt(wss("ws://127.0.0.1/x", "/x")), ctx);
    assert.equal(r.status, 403);
    assert.equal(r.error?.kind, "ssrf_blocked");
    assert.equal(connected, false);
});

test("READ: a connect throw settles error (502), not an unhandled throw", async () => {
    const { ctx, inspect } = makeCtx();
    const r = await new Ws(() => { throw new Error("handshake refused"); }).read(readStmt(wss(PUB, "/feed")), ctx);
    assert.equal(r.status, 502);
    assert.equal(inspect().closed?.reason, "error");
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
    assert.equal(r.error?.kind, "no_open_socket");
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
    assert.equal(inspect().closed?.reason, "done");
});

test("KILL: no open socket → 404", async () => {
    const { ctx } = makeCtx();
    const r = await new Ws(() => fakeSocket()).kill(killStmt(wss(PUB, "/feed")), ctx);
    assert.equal(r.status, 404);
    assert.equal(r.error?.kind, "no_open_socket");
});

test("cancel: the composed abort signal closes the socket", async () => {
    const sock = fakeSocket();
    const { ctx, localAbort, inspect } = makeCtx();
    const read = new Ws(() => sock).read(readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    localAbort.abort(); // loop.cancel → onAbort → socket.close → close listener → settle
    await read;
    assert.deepEqual(sock.closed, { code: 1000, reason: "cancelled" });
    assert.equal(inspect().closed?.reason, "done");
});
