// WebSocket ownership and settlement coverage {§ws-lifecycle}. Hermetic:
// injected fake socket (no real WebSocket). The fake preserves native
// CONNECTING/OPEN/CLOSING send semantics, and close() fires
// its own `close` listener, mirroring the real WebSocket.

import test from "node:test";
import { strict as assert } from "node:assert";
import Ws from "./Ws.ts";
import {
    NetworkAddress,
    Results,
    type SchemeCtx,
    type UrlPath,
    type ReadStatement,
    type ResolvedEditStatement,
    type SendStatement,
    type KillStatement,
    type EntryCaps,
    type EntryStorageWriteResult,
    type ChannelCaps,
    type NotifyCaps,
    type ProjectionCaps,
    type SubscriptionCaps,
    type StreamSubscription,
} from "@plurnk/plurnk-schemes";

const PUB = "wss://93.184.216.34/feed"; // public IP literal - skips DNS

interface SocketEvent { data?: unknown; code?: number; reason?: string; message?: string }
const fakeSocket = () => {
    const CONNECTING = 0;
    const OPEN = 1;
    const CLOSING = 2;
    const CLOSED = 3;
    const listeners = new Map<string, (ev: SocketEvent) => void>();
    const sent: string[] = [];
    let closed: { code?: number; reason?: string } | null = null;
    let readyState = CONNECTING;
    const fire = (type: string, ev: SocketEvent = {}) => {
        if (type === "open") readyState = OPEN;
        if (type === "close") readyState = CLOSED;
        if (type === "message" && readyState !== OPEN) return;
        listeners.get(type)?.(ev);
    };
    return {
        sent,
        get closed() { return closed; },
        get readyState() { return readyState; },
        addEventListener(type: string, fn: (ev: SocketEvent) => void, options?: { once?: boolean }) {
            listeners.set(type, options?.once
                ? (event) => {
                    listeners.delete(type);
                    fn(event);
                }
                : fn);
        },
        send(data: string) {
            if (readyState === CONNECTING) throw new DOMException("WebSocket is not open", "InvalidStateError");
            if (readyState !== OPEN) return;
            sent.push(data);
        },
        close(code?: number, reason?: string) {
            if (readyState === CLOSING || readyState === CLOSED) return;
            if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
                throw new DOMException("invalid code", "InvalidAccessError");
            }
            closed = { code, reason };
            readyState = CLOSING;
            fire("close", { code, reason });
        },
        startClosing() { readyState = CLOSING; },
        emit: fire,
    };
};

interface CtxOverrides {
    readonly workspaceId?: number;
    readonly workerId?: number;
    readonly write?: EntryCaps["write"];
    readonly setState?: ChannelCaps["setState"];
    readonly streamEvent?: NotifyCaps["streamEvent"];
    readonly notifyChunk?: SubscriptionCaps["notifyChunk"];
    readonly close?: SubscriptionCaps["close"];
}

const makeCtx = (overrides: CtxOverrides = {}) => {
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let opened: { pathname: string } | null = null;
    type ClosedSubscription = { result: Parameters<SubscriptionCaps["close"]>[0]; summary?: string };
    let closed: ClosedSubscription | null = null;
    const settled = Promise.withResolvers<ClosedSubscription>();
    void settled.promise.catch(() => {});
    let closeCount = 0;
    let wrote: string | null = null;
    const stateChanges: Array<{ pathname: string; channel: string; state: string }> = [];
    const streamEvents: Array<{ pathname: string; channel: string; state: string; contentLength: number }> = [];
    const localAbort = new AbortController();

    const entries: EntryCaps = {
        operations: {
            async editBatch() { return { status: 501, entryId: null, channel: null }; },
            async read() { return { status: 501, content: null, mimetype: null, channel: null }; },
            async find() { return { status: 501, content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0, matchingPathCount: 0, matchLocationCount: 0 }; },
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
        async write(pathname, entry) {
            wrote = pathname;
            return overrides.write?.(pathname, entry)
                ?? { status: 201, created: true, entryId: 1 };
        },
        async delete() { return { status: 200 }; },
    };
    const channels: ChannelCaps = {
        async append() { return { status: 200 }; },
        async replace() { return { status: 200 }; },
        async setState(pathname, channel, state) {
            stateChanges.push({ pathname, channel, state });
            return overrides.setState?.(pathname, channel, state) ?? { status: 200 };
        },
    };
    const notify: NotifyCaps = {
        streamEvent(pathname, channel, state, contentLength) {
            streamEvents.push({ pathname, channel, state, contentLength });
            overrides.streamEvent?.(pathname, channel, state, contentLength);
        },
    };
    const projection: ProjectionCaps = {
        async readable(content, mimetype) {
            return {
                content,
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: `test:${mimetype}`,
            };
        },
        async readableBytes() { return null; },
        async identity(mimetype) { return `test:${mimetype}`; },
        async isBinary() { return false; },
        async parseIssues() { return undefined; },
    };
    let current: StreamSubscription | null = null;
    const notifyChunk: StreamSubscription["notifyChunk"] = async (channel, chunk, mimetype) => {
        await overrides.notifyChunk?.(channel, chunk, mimetype);
        chunks.push({ channel, chunk, mimetype });
    };
    const close: StreamSubscription["close"] = async (result, summary) => {
        closeCount += 1;
        closed = { result, summary };
        try {
            await overrides.close?.(result, summary);
            settled.resolve(closed);
        } catch (error) {
            settled.reject(error);
            throw error;
        }
    };
    const subscriptions: SubscriptionCaps = {
        async open(pathname) {
            opened = { pathname };
            current = Object.assign(localAbort.signal, { notifyChunk, close });
            return current;
        },
        async notifyChunk(channel, chunk, mimetype) {
            if (current === null) throw new Error("no open subscription");
            await current.notifyChunk(channel, chunk, mimetype);
        },
        async close(result, summary) {
            if (current === null) throw new Error("no open subscription");
            await current.close(result, summary);
        },
    };
    const ctx: SchemeCtx = {
        workspaceId: overrides.workspaceId ?? 1, workerId: overrides.workerId ?? 1, functionalityWorkerId: overrides.workerId ?? 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries, channels, notify, projection,
        interactions: { request: async () => ({ status: "cancelled" }) },
        subscriptions,
    };
    return {
        ctx,
        localAbort,
        inspect: () => ({ chunks, opened, closed, closeCount, wrote, stateChanges, streamEvents }),
        awaitClosed: () => settled.promise,
    };
};

const wss = (raw: string, pathname: string): UrlPath => {
    const url = new URL(raw);
    return {
        kind: "url", raw, scheme: url.protocol.slice(0, -1),
        username: url.username || null, password: url.password || null,
        hostname: url.hostname || null, port: url.port === "" ? null : Number(url.port),
        pathname, query: url.search === "" ? null : url.search.slice(1), fragment: null,
    };
};
const readStmt = (target: UrlPath): ReadStatement => ({ op: "READ", delimiter: "READ", annotation: null, signal: null, target, metadata: null, lineMarker: null, body: null, position: { line: 0, column: 0 } });
const editStmt = (
    target: UrlPath,
    body: string | null,
    lineMarker: ResolvedEditStatement["lineMarker"] = null,
): ResolvedEditStatement => ({ op: "EDIT", delimiter: "EDIT", annotation: null, signal: null, target, metadata: null, lineMarker, body, position: { line: 0, column: 0 } });
const prepareRepresentation = (ws: Ws, statement: ReadStatement, ctx: SchemeCtx) => {
    const target = statement.target;
    if (target === null || target.kind !== "url") throw new TypeError("WebSocket READ requires a URL target");
    const address = NetworkAddress.from(target);
    return ws.prepareRepresentation({
        target: { ...target, fragment: null },
        metadata: statement.metadata,
        authority: address.authority,
        pathname: address.pathname,
    }, ctx);
};
const sendStmt = (signal: number, target: UrlPath, body?: string): SendStatement => ({ op: "SEND", delimiter: "SEND", annotation: null, signal, target, metadata: null, lineMarker: null, body: body === undefined ? null : { raw: body, json: null }, position: { line: 0, column: 0 } });
const killStmt = (target: UrlPath): KillStatement => ({ op: "KILL", delimiter: "KILL", annotation: null, signal: null, target, metadata: null, lineMarker: null, body: null, position: { line: 0, column: 0 } });

const flush = () => new Promise((r) => setImmediate(r));

test("manifest: wss scheme - messages channel, requiresWeb, network-volatile", () => {
    assert.equal(Ws.manifest.name, "wss");
    assert.equal(Ws.manifest.authority, "resource");
    assert.equal(Ws.manifest.glyph, "🔌");
    assert.equal(Ws.manifest.defaultChannel, "messages");
    assert.deepEqual(Object.keys(Ws.manifest.channels), ["messages"]);
    assert.equal(Ws.manifest.flags?.requiresWeb, true);
    assert.equal(Ws.manifest.volatile, true);
    const examples = (Ws.manifest.example ?? "").split("\n\n");
    assert.equal(examples.length, 3, "WebSocket teaches connection acquisition and both outbound choices");
    const read = examples[0]?.match(/^## READ0 \((wss:\/\/[^)]+)\)$/u);
    const edit = examples[1]?.match(/^## EDIT0 \((wss:\/\/[^)]+)\)\n.+$/u);
    const send = examples[2]?.match(/^## SEND0 \[200\] \((wss:\/\/[^)]+)\)\n.+$/u);
    assert.ok(read);
    assert.ok(edit);
    assert.ok(send);
    assert.equal(edit[1], read[1], "EDIT addresses the connection acquired by READ");
    assert.equal(send[1], read[1], "SEND addresses the connection acquired by READ");
});

test("manifest: documentation is loaded verbatim from docs/wss.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const fromFile = await readFile(new URL("../docs/wss.md", import.meta.url), "utf-8");
    assert.equal(Ws.manifest.documentation, fromFile);
    assert.match(Ws.manifest.documentation ?? "", /^# wss:\/\//);
    assert.match(Ws.manifest.documentation ?? "", /^## Summary\n\nMaintain persistent, bidirectional WebSocket connections as addressable entries\.$/m);
});

test("READ: inbound frames stream into messages; socket close settles done", async () => {
    const sock = fakeSocket();
    const { ctx, inspect, awaitClosed } = makeCtx();
    const p = prepareRepresentation(new Ws(() => sock), readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("open");
    await flush();
    sock.emit("message", { data: "hello" });
    sock.emit("message", { data: "world" });
    await flush();
    sock.close(1000);
    const r = await p;
    await awaitClosed();

    assert.equal(r.status, 102);
    const { chunks, opened, closed, wrote } = inspect();
    assert.equal(wrote, "/feed"); // create-then-subscribe
    assert.equal(opened?.pathname, "/feed");
    assert.deepEqual(chunks.filter((c) => c.channel === "messages").map((c) => c.chunk), ["hello", "world"]);
    assert.ok(chunks.every((c) => c.channel !== "messages" || c.mimetype === "text/plain"));
    assert.equal(closed?.result.status, 200);
    assert.equal(closed?.summary, "ws closed (1000); 2 messages");
});

test("READ: returns 102 after native open while the socket remains owned", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => sock);
    const { ctx, inspect, awaitClosed } = makeCtx();
    const target = wss(PUB, "/feed");
    let returned = false;
    const read = prepareRepresentation(ws, readStmt(target), ctx);
    void read.then(() => { returned = true; });

    await flush();
    assert.equal(returned, false, "claiming and CONNECTING do not complete acquisition");
    sock.emit("open");
    await flush();
    const returnedWhileOpen = returned;
    assert.equal((await ws.send(sendStmt(200, target, "same actor can continue"), ctx)).status, 200);
    sock.close(1000);
    assert.equal((await read).status, 102);
    await awaitClosed();

    assert.equal(returnedWhileOpen, true, "native open plus durable activation returns the owning READ");
    assert.deepEqual(sock.sent, ["same actor can continue"]);
    assert.equal(inspect().closed?.result.status, 200);
});

test("READ: terminal settlement waits for in-flight message persistence", async () => {
    const persistenceGate = Promise.withResolvers<void>();
    const sock = fakeSocket();
    const { ctx, inspect, awaitClosed } = makeCtx({
        notifyChunk: async () => { await persistenceGate.promise; },
    });
    const read = prepareRepresentation(new Ws(() => sock), readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("open");
    await flush();
    sock.emit("message", { data: "durable first" });
    await flush();

    assert.equal((await read).status, 102, "the acquired READ is already complete");
    let terminalSettled = false;
    void awaitClosed().then(() => { terminalSettled = true; });
    sock.emit("close", { code: 1000 });
    await flush();
    assert.equal(terminalSettled, false);
    assert.equal(inspect().closed, null, "subscription cleanup follows pending message persistence");

    persistenceGate.resolve();
    await awaitClosed();
    assert.deepEqual(inspect().chunks.map(({ chunk }) => chunk), ["durable first"]);
    assert.equal(inspect().closed?.result.status, 200);
});

test("READ: inbound persistence remains transport-ordered under inverted latency", async () => {
    const firstGate = Promise.withResolvers<void>();
    const attempts: string[] = [];
    const sock = fakeSocket();
    const { ctx, inspect, awaitClosed } = makeCtx({
        notifyChunk: async (_channel, chunk) => {
            attempts.push(chunk);
            if (chunk === "first") await firstGate.promise;
        },
    });
    const read = prepareRepresentation(new Ws(() => sock), readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("open");
    assert.equal((await read).status, 102);

    sock.emit("message", { data: "first" });
    sock.emit("message", { data: "second" });
    await flush();
    assert.deepEqual(attempts, ["first"], "the second write cannot begin while the first is pending");
    assert.deepEqual(inspect().chunks, []);

    firstGate.resolve();
    await flush();
    assert.deepEqual(attempts, ["first", "second"]);
    assert.deepEqual(inspect().chunks.map(({ chunk }) => chunk), ["first", "second"]);

    sock.emit("close", { code: 1000 });
    await awaitClosed();
    assert.equal(inspect().closed?.summary, "ws closed (1000); 2 messages");
});

for (const [form, data] of [
    ["Blob", new Blob([Uint8Array.of(1, 2, 3)])],
    ["ArrayBuffer", new ArrayBuffer(3)],
] as const) {
    test(`READ: a ${form} binary frame terminates the textual owner after its durable prefix`, async () => {
        const firstGate = Promise.withResolvers<void>();
        const attempts: string[] = [];
        const sock = fakeSocket();
        const { ctx, inspect, awaitClosed } = makeCtx({
            notifyChunk: async (_channel, chunk) => {
                attempts.push(chunk);
                if (chunk === "durable prefix") await firstGate.promise;
            },
        });
        const ws = new Ws(() => sock);
        const target = wss(PUB, "/feed");
        const read = prepareRepresentation(ws, readStmt(target), ctx);
        await flush();
        sock.emit("open");
        assert.equal((await read).status, 102);

        sock.emit("message", { data: "durable prefix" });
        sock.emit("message", { data });
        sock.emit("message", { data: "pruned suffix" });
        await flush();
        assert.deepEqual(attempts, ["durable prefix"], "the binary frame waits behind accepted persistence");

        firstGate.resolve();
        await flush();
        sock.close(1000);
        const terminal = await awaitClosed();

        assert.deepEqual(attempts, ["durable prefix"], "neither binary object labels nor later frames are persisted");
        assert.deepEqual(inspect().chunks.map(({ chunk }) => chunk), ["durable prefix"]);
        assert.equal(terminal.result.status, 415);
        assert.equal(terminal.result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/binary-frame-unsupported");
        assert.equal(terminal.result.problem?.stage, "materialization");
        assert.equal(terminal.result.problem?.retryable, false);
        assert.equal(terminal.summary, "The received WebSocket frame is binary; the messages channel accepts text only.");
        assert.deepEqual(sock.closed, { code: 4003, reason: "binary unsupported" });
        assert.equal(inspect().closeCount, 1);
        await flush();
        assert.equal((await ws.send(sendStmt(200, target, "late"), ctx)).status, 409);
    });
}

test("READ: an explicit loopback target reaches the configured socket transport", async () => {
    const sock = fakeSocket();
    let connected: string | null = null;
    const { ctx, awaitClosed } = makeCtx();
    const read = prepareRepresentation(
        new Ws((url) => { connected = url; return sock; }),
        readStmt(wss("ws://127.0.0.1/x", "/x")),
        ctx,
    );
    await flush();
    assert.equal(connected, "ws://127.0.0.1/x");
    sock.emit("open");
    await flush();
    sock.close(1000);
    assert.equal((await read).status, 102);
    await awaitClosed();
});

test("READ: a connect throw settles error (502), not an unhandled throw", async () => {
    const { ctx, inspect } = makeCtx();
    const r = await prepareRepresentation(new Ws(() => { throw new Error("handshake refused"); }), readStmt(wss(PUB, "/feed")), ctx);
    assert.equal(r.status, 502);
    assert.equal(r.problem?.detail, `The WebSocket connection to ${PUB} failed.`);
    assert.equal(r.problem?.stage, "connection");
    assert.equal(r.problem?.retryable, true);
    assert.equal(inspect().closed?.result.status, 502);
    assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/connect-failed");
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
    const result = await prepareRepresentation(
        new Ws(() => {
            connected = true;
            return fakeSocket();
        }),
        readStmt(wss(PUB, "/feed")),
        ctx,
    );
    assert.deepEqual(result, { ...failure, shape: "passthrough" });
    assert.equal(connected, false);
    assert.equal(inspect().opened, null);
});

test("SEND[200]: connecting is 409, open is sendable, and closing cannot silently discard", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => sock);
    const { ctx, inspect, awaitClosed } = makeCtx();
    const target = wss(PUB, "/feed");
    const read = prepareRepresentation(ws, readStmt(target), ctx); // owner exists while READ remains pending
    await flush();

    const early = await ws.send(sendStmt(200, target, "early"), ctx);
    assert.equal(early.status, 409);
    assert.equal(early.problem?.type, "https://problems.plurnk.xyz/scheme/wss/socket-not-open");
    assert.equal(early.problem?.connectionState, "connecting");
    assert.deepEqual(sock.sent, []);

    sock.emit("open");
    await flush();
    assert.deepEqual(inspect().stateChanges, [{
        pathname: "/feed",
        channel: "messages",
        state: "active",
    }]);
    assert.deepEqual(inspect().streamEvents, [{
        pathname: "/feed",
        channel: "messages",
        state: "active",
        contentLength: 0,
    }]);
    assert.equal((await ws.send(sendStmt(200, target, "ping"), ctx)).status, 200);
    assert.deepEqual(sock.sent, ["ping"]);

    sock.startClosing();
    const late = await ws.send(sendStmt(200, target, "late"), ctx);
    assert.equal(late.status, 409);
    assert.equal(late.problem?.connectionState, "settling");
    assert.deepEqual(sock.sent, ["ping"], "SEND cannot report success for a native no-op after closing starts");

    sock.emit("close", { code: 1000 });
    await read;
    await awaitClosed();
});

test("SEND[200]: a claimed owner is distinct from an absent connection", async () => {
    const writeGate = Promise.withResolvers<void>();
    const sock = fakeSocket();
    const ws = new Ws(() => sock);
    const { ctx, awaitClosed } = makeCtx({
        write: async () => {
            await writeGate.promise;
            return { status: 201, created: true, entryId: 1 };
        },
    });
    const target = wss(PUB, "/feed");
    const read = prepareRepresentation(ws, readStmt(target), ctx);
    await flush();

    const result = await ws.send(sendStmt(200, target, "early"), ctx);
    assert.equal(result.status, 409);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/socket-not-open");
    assert.equal(result.problem?.connectionState, "claimed");

    writeGate.resolve();
    await flush();
    sock.emit("open");
    await flush();
    sock.close(1000);
    await read;
    await awaitClosed();
});

test("READ: channel activation preserves an exact capability failure", async () => {
    const failure = Results.failure(
        "scheme:test",
        "channel-state-read-only",
        503,
        "The channel state store is read-only.",
        {},
        { stage: "persistence", retryable: false },
    );
    const sock = fakeSocket();
    const { ctx, inspect } = makeCtx({ setState: async () => failure });
    const read = prepareRepresentation(new Ws(() => sock), readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("open");
    const result = await read;

    assert.deepEqual(result, { ...failure, shape: "passthrough" });
    assert.equal(inspect().closed?.result.problem, failure.problem);
    assert.notEqual(sock.closed, null);
});

test("READ: a thrown channel activation becomes a structured terminal failure", async () => {
    const sock = fakeSocket();
    const { ctx, inspect } = makeCtx({
        setState: async () => { throw new Error("raw state failure"); },
    });
    const read = prepareRepresentation(new Ws(() => sock), readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("open");
    const result = await read;

    assert.equal(result.status, 500);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/channel-activation-failed");
    assert.equal(result.problem?.stage, "persistence");
    assert.equal(inspect().closed?.result.problem, result.problem);
    assert.notEqual(sock.closed, null);
});

test("READ: a thrown activation notification remains a direct acquisition failure", async () => {
    const sock = fakeSocket();
    const { ctx, inspect } = makeCtx({
        streamEvent() { throw new Error("raw notification failure"); },
    });
    const read = prepareRepresentation(new Ws(() => sock), readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("open");
    const result = await read;

    assert.equal(result.status, 500);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/channel-activation-failed");
    assert.equal(inspect().closed?.result.problem, result.problem);
    assert.notEqual(sock.closed, null);
});

test("READ: a close before open is one connection failure and releases ownership", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => sock);
    const { ctx, inspect } = makeCtx();
    const target = wss(PUB, "/feed");
    const read = prepareRepresentation(ws, readStmt(target), ctx);
    await flush();
    sock.emit("close", { code: 1006 });
    const result = await read;

    assert.equal(result.status, 502);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/connection-failed");
    assert.equal(inspect().closeCount, 1);
    assert.equal((await ws.send(sendStmt(200, target, "late"), ctx)).status, 409);
});

test("READ: terminal cleanup exposes the existing canonical representation until it settles", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    let connects = 0;
    const cleanupGate = Promise.withResolvers<void>();
    const firstCtx = makeCtx({ close: async () => { await cleanupGate.promise; } });
    const secondCtx = makeCtx();
    const ws = new Ws(() => sockets[connects++]!);
    const target = wss(PUB, "/feed");
    void prepareRepresentation(ws, readStmt(target), firstCtx.ctx);
    await flush();
    sockets[0].emit("open");
    await flush();
    sockets[0].emit("close", { code: 1000 });
    await flush();

    const duplicateRead = prepareRepresentation(ws, readStmt(target), secondCtx.ctx);
    await flush();
    if (connects > 1) sockets[1].emit("close", { code: 1006 });
    const duplicate = await duplicateRead;
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.connectionState, "settling");
    assert.equal(connects, 1);

    cleanupGate.resolve();
    await firstCtx.awaitClosed();
});

test("READ: duplicate canonical workspace address reuses its representation and owner", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    let connects = 0;
    const ws = new Ws(() => sockets[connects++]!);
    const firstCtx = makeCtx();
    const secondCtx = makeCtx();
    const target = wss(PUB, "/feed");
    const firstRead = prepareRepresentation(ws, readStmt(target), firstCtx.ctx);
    try {
        await flush();
        sockets[0].emit("open");
        await flush();
        const secondRead = prepareRepresentation(ws, readStmt(target), secondCtx.ctx);
        await flush();
        if (connects > 1) sockets[1].close(1000);
        const result = await secondRead;

        assert.equal(result.status, 200);
        assert.equal(result.connectionState, "open");
        assert.equal(connects, 1, "the duplicate does not create a second transport");
        assert.equal(secondCtx.inspect().wrote, null, "the duplicate has no storage side effects");
        assert.equal(secondCtx.inspect().opened, null, "the duplicate opens no subscription");
        assert.equal((await ws.send(sendStmt(200, target, "still-owned"), firstCtx.ctx)).status, 200);
        assert.deepEqual(sockets[0].sent, ["still-owned"]);
    } finally {
        sockets[0].close(1000);
        await firstRead;
        await firstCtx.awaitClosed();
    }
});

test("socket ownership isolates the same canonical address by owning worker within one workspace", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    let connects = 0;
    const ws = new Ws(() => sockets[connects++]!);
    const firstCtx = makeCtx({ workspaceId: 1, workerId: 11 });
    const secondCtx = makeCtx({ workspaceId: 1, workerId: 12 });
    const target = wss(PUB, "/feed");
    const reads = [
        prepareRepresentation(ws, readStmt(target), firstCtx.ctx),
        prepareRepresentation(ws, readStmt(target), secondCtx.ctx),
    ];
    await flush();
    sockets[0].emit("open");
    sockets[1].emit("open");
    await flush();

    assert.equal((await ws.send(sendStmt(200, target, "first"), firstCtx.ctx)).status, 200);
    assert.equal((await ws.send(sendStmt(200, target, "second"), secondCtx.ctx)).status, 200);
    assert.deepEqual(sockets[0].sent, ["first"]);
    assert.deepEqual(sockets[1].sent, ["second"]);

    sockets[0].close(1000);
    sockets[1].close(1000);
    await Promise.all(reads);
    await Promise.all([firstCtx.awaitClosed(), secondCtx.awaitClosed()]);
});

test("socket lookup isolates addressed protocol, port, and ordered query", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => sock);
    const { ctx, inspect, awaitClosed } = makeCtx();
    const opened = wss("wss://93.184.216.34:8443/feed?room=1&role=a&role=b", "/feed");
    const read = prepareRepresentation(ws, readStmt(opened), ctx);
    await flush();
    sock.emit("open");
    await flush();
    assert.equal(inspect().wrote, "/feed?room=1&role=a&role=b");

    const reordered = wss("wss://93.184.216.34:8443/feed?role=a&role=b&room=1", "/feed");
    assert.equal((await ws.send(sendStmt(200, reordered, "wrong"), ctx)).status, 409);
    const plain = wss("ws://93.184.216.34:8443/feed?room=1&role=a&role=b", "/feed");
    assert.equal((await ws.send(sendStmt(200, plain, "wrong"), ctx)).status, 409);
    assert.equal((await ws.send(sendStmt(200, opened, "right"), ctx)).status, 200);
    assert.deepEqual(sock.sent, ["right"]);
    sock.close(1000);
    await read;
    await awaitClosed();
});

test("WebSocket userinfo is rejected before connection", async () => {
    let connected = false;
    const { ctx } = makeCtx();
    const result = await prepareRepresentation(
        new Ws(() => {
            connected = true;
            return fakeSocket();
        }),
        readStmt(wss("wss://alice:secret@93.184.216.34/feed", "/feed")),
        ctx,
    );
    assert.equal(result.status, 400);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/userinfo-not-allowed");
    assert.equal(result.problem?.target, "wss://93.184.216.34/feed");
    assert.doesNotMatch(JSON.stringify(result), /alice|secret/);
    assert.equal(connected, false);
});

test("EDIT and SEND[200]: no claimed socket → 409", async () => {
    const { ctx } = makeCtx();
    const ws = new Ws(() => fakeSocket());
    const target = wss(PUB, "/feed");
    const send = await ws.send(sendStmt(200, target, "x"), ctx);
    const edit = await ws.editBatch([editStmt(target, "x")], ctx);
    for (const result of [edit, send]) {
        assert.equal(result.status, 409);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/no-open-socket");
        assert.equal(result.problem?.recovery, "READ the WebSocket URL before sending a message.");
    }
});

test("EDIT and SEND[200]: both send one whole text frame through the open owner", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => sock);
    const { ctx, awaitClosed } = makeCtx();
    const target = wss(PUB, "/feed");
    const read = prepareRepresentation(ws, readStmt(target), ctx);
    await flush();
    sock.emit("open");
    await flush();

    assert.equal((await ws.editBatch([editStmt(target, "edit frame")], ctx)).status, 200);
    assert.equal((await ws.send(sendStmt(200, target, "send frame"), ctx)).status, 200);
    assert.deepEqual(sock.sent, ["edit frame", "send frame"]);

    sock.close(1000);
    await read;
    await awaitClosed();
});

test("EDIT: ranges and multi-edit pseudo-atomicity are rejected", async () => {
    const ws = new Ws(() => fakeSocket());
    const { ctx } = makeCtx();
    const target = wss(PUB, "/feed");
    const ranged = await ws.editBatch([
        editStmt(target, "partial", { marks: [1] }),
    ], ctx);
    assert.equal(ranged.status, 400);
    assert.equal(ranged.problem?.type, "https://problems.plurnk.xyz/scheme/wss/line-edit-unsupported");

    const multiple = await ws.editBatch([
        editStmt(target, "one"),
        editStmt(target, "two"),
    ], ctx);
    assert.equal(multiple.status, 409);
    assert.equal(multiple.problem?.type, "https://problems.plurnk.xyz/scheme/wss/non-atomic-edit-batch");
});

test("SEND[200]: a socket send throw becomes a structured transport failure", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => ({
        ...sock,
        get readyState() { return sock.readyState; },
        send() { throw new Error("raw socket failure"); },
    }));
    const { ctx, awaitClosed } = makeCtx();
    const read = prepareRepresentation(ws, readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("open");
    await flush();
    const result = await ws.send(sendStmt(200, wss(PUB, "/feed"), "ping"), ctx);
    assert.equal(result.status, 502);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/send-failed");
    assert.equal(result.problem?.detail, "The WebSocket message could not be sent.");
    assert.equal(result.problem?.stage, "transfer");
    sock.close(1000);
    await read;
    await awaitClosed();
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
    assert.equal(r.problem?.type, "https://problems.plurnk.xyz/scheme/wss/send-status-unsupported");
    assert.equal(r.problem?.requestedStatus, 203);
    assert.equal(r.problem?.stage, "dispatch");
});

test("KILL: closes the claimed socket and settles the READ", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => sock);
    const { ctx, inspect } = makeCtx();
    const read = prepareRepresentation(ws, readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    const r = await ws.kill(killStmt(wss(PUB, "/feed")), ctx);
    assert.equal(r.status, 200);
    assert.deepEqual(sock.closed, { code: 1000, reason: "killed" });
    await read; // KILL's close fired the READ's close listener → resolves
    assert.equal(inspect().closed?.result.status, 200);
});

test("KILL: cancels an owner claimed before socket construction", async () => {
    const writeGate = Promise.withResolvers<void>();
    const ws = new Ws(() => fakeSocket());
    const { ctx } = makeCtx({
        write: async () => {
            await writeGate.promise;
            return { status: 201, created: true, entryId: 1 };
        },
    });
    const target = wss(PUB, "/feed");
    const read = prepareRepresentation(ws, readStmt(target), ctx);
    await flush();

    assert.equal((await ws.kill(killStmt(target), ctx)).status, 200);
    writeGate.resolve();
    assert.equal((await read).status, 499);
    assert.equal((await ws.kill(killStmt(target), ctx)).status, 404);
});

test("KILL: no claimed socket → 404", async () => {
    const { ctx } = makeCtx();
    const r = await new Ws(() => fakeSocket()).kill(killStmt(wss(PUB, "/feed")), ctx);
    assert.equal(r.status, 404);
    assert.equal(r.problem?.type, "https://problems.plurnk.xyz/scheme/wss/no-open-socket");
});

test("KILL: a socket close throw becomes a structured transport failure", async () => {
    const sock = fakeSocket();
    const ws = new Ws(() => ({
        ...sock,
        close() { throw new Error("raw socket failure"); },
    }));
    const { ctx } = makeCtx();
    void prepareRepresentation(ws, readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    const result = await ws.kill(killStmt(wss(PUB, "/feed")), ctx);
    assert.equal(result.status, 502);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/close-failed");
    assert.equal(result.problem?.detail, "The WebSocket connection could not be closed.");
});

test("READ: message persistence failure settles with a structured problem", async () => {
    const sock = fakeSocket();
    const attempts: string[] = [];
    const { ctx, inspect, awaitClosed } = makeCtx({
        notifyChunk: async (_channel, chunk) => {
            attempts.push(chunk);
            throw new Error("raw persistence failure");
        },
    });
    const ws = new Ws(() => sock);
    const target = wss(PUB, "/feed");
    const read = prepareRepresentation(ws, readStmt(target), ctx);
    await flush();
    sock.emit("open");
    await flush();
    assert.equal((await read).status, 102);
    sock.emit("message", { data: "failed prefix" });
    sock.emit("message", { data: "queued suffix" });
    const terminal = await awaitClosed();
    assert.equal(terminal.result.status, 500);
    assert.equal(terminal.result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/message-persistence-failed");
    assert.equal(terminal.result.problem?.stage, "persistence");
    assert.equal(inspect().closed?.result.problem, terminal.result.problem);
    assert.deepEqual(attempts, ["failed prefix"], "the first failure prunes the queued suffix");
    assert.deepEqual(inspect().chunks, [], "a failed write is not recorded as persisted");
    assert.equal(inspect().closeCount, 1);
    assert.notEqual(sock.closed, null, "a terminal persistence failure closes its transport");
    await flush();
    assert.equal((await ws.send(sendStmt(200, target, "late"), ctx)).status, 409, "terminal cleanup releases address ownership");
});

test("READ: a pending persistence failure supersedes graceful close", async () => {
    const persistenceGate = Promise.withResolvers<void>();
    const sock = fakeSocket();
    const { ctx, inspect, awaitClosed } = makeCtx({
        notifyChunk: async () => {
            await persistenceGate.promise;
            throw new Error("late persistence failure");
        },
    });
    const read = prepareRepresentation(new Ws(() => sock), readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("open");
    assert.equal((await read).status, 102);
    sock.emit("message", { data: "accepted before close" });
    await flush();

    sock.emit("close", { code: 1000 });
    persistenceGate.resolve();
    const terminal = await awaitClosed();

    assert.equal(terminal.result.status, 500);
    assert.equal(terminal.result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/message-persistence-failed");
    assert.equal(terminal.summary, "The received WebSocket message could not be persisted.");
    assert.equal(inspect().closeCount, 1);
});

test("READ: a pre-open transport error closes once before settling", async () => {
    const sock = fakeSocket();
    const { ctx, inspect } = makeCtx();
    const ws = new Ws(() => sock);
    const target = wss(PUB, "/feed");
    const read = prepareRepresentation(ws, readStmt(target), ctx);
    await flush();
    sock.emit("error", { message: "connection reset" });
    const result = await read;

    assert.equal(result.status, 502);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/connection-failed");
    assert.equal(inspect().closed?.result.problem, result.problem);
    assert.equal(inspect().closeCount, 1, "the error+close event pair has one settlement owner");
    assert.deepEqual(sock.closed, { code: 4011, reason: "transport failed" });
    assert.equal((await ws.send(sendStmt(200, target, "late"), ctx)).status, 409, "terminal cleanup releases address ownership");
});

test("READ: a post-acquisition transport error settles the retained stream", async () => {
    const sock = fakeSocket();
    const { ctx, awaitClosed } = makeCtx();
    const ws = new Ws(() => sock);
    const target = wss(PUB, "/feed");
    const read = prepareRepresentation(ws, readStmt(target), ctx);
    await flush();
    sock.emit("open");
    assert.equal((await read).status, 102);

    sock.emit("error", { message: "connection reset" });
    const terminal = await awaitClosed();
    assert.equal(terminal.result.status, 502);
    assert.equal(terminal.result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/connection-failed");
    await flush();
    assert.equal((await ws.send(sendStmt(200, target, "late"), ctx)).status, 409);
});

test("READ: subscription close rejection is diagnosed after the acquired READ", async (t) => {
    const sock = fakeSocket();
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const { ctx, awaitClosed } = makeCtx({
        close: async () => { throw new Error("subscription close failed"); },
    });
    const read = prepareRepresentation(new Ws(() => sock), readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    sock.emit("open");
    await flush();
    assert.equal((await read).status, 102);
    sock.close(1000);
    await assert.rejects(awaitClosed(), /subscription close failed/);
    await flush();
    assert.equal(diagnostics.some(([message]) => message === "WebSocket terminal cleanup failed"), true);
});

test("cancel: the composed abort signal closes the socket", async () => {
    const sock = fakeSocket();
    const { ctx, localAbort, inspect } = makeCtx();
    const read = prepareRepresentation(new Ws(() => sock), readStmt(wss(PUB, "/feed")), ctx);
    await flush();
    localAbort.abort(); // loop.cancel → onAbort → socket.close → close listener → settle
    await read;
    assert.deepEqual(sock.closed, { code: 1000, reason: "cancelled" });
    assert.equal(inspect().closed?.result.status, 499);
    assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.xyz/scheme/wss/cancelled");
});

test("handler close closes every remaining socket and waits for READ cleanup", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    let connects = 0;
    const cleanupGate = Promise.withResolvers<void>();
    const firstCtx = makeCtx();
    const secondCtx = makeCtx({ close: async () => { await cleanupGate.promise; } });
    const ws = new Ws(() => sockets[connects++]!);
    const reads = [
        prepareRepresentation(ws, readStmt(wss("wss://93.184.216.34/one", "/one")), firstCtx.ctx),
        prepareRepresentation(ws, readStmt(wss(`${PUB}?room=two`, "/feed")), secondCtx.ctx),
    ];
    await flush();

    let shutdownSettled = false;
    const shutdown = ws.close().then(() => { shutdownSettled = true; });
    await flush();
    assert.notEqual(sockets[0].closed, null);
    assert.notEqual(sockets[1].closed, null);
    assert.equal(shutdownSettled, false, "handler close waits for subscription cleanup");

    cleanupGate.resolve();
    await shutdown;
    const results = await Promise.all(reads);
    assert.deepEqual(results.map(({ status }) => status), [499, 499]);
    assert.equal((await ws.send(sendStmt(200, wss("wss://93.184.216.34/one", "/one"), "late"), firstCtx.ctx)).status, 409);
});

test("handler close settles every READ and aggregates transport close failures", async () => {
    const first = fakeSocket();
    const second = fakeSocket();
    let connects = 0;
    const ws = new Ws(() => connects++ === 0
        ? { ...first, close() { throw new Error("first close failed"); } }
        : second);
    const firstCtx = makeCtx();
    const secondCtx = makeCtx();
    const reads = [
        prepareRepresentation(ws, readStmt(wss("wss://93.184.216.34/one", "/one")), firstCtx.ctx),
        prepareRepresentation(ws, readStmt(wss(`${PUB}?room=two`, "/feed")), secondCtx.ctx),
    ];
    await flush();

    await assert.rejects(
        () => ws.close(),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors.map((cause) => String(cause)), ["Error: first close failed"]);
            return true;
        },
    );
    assert.notEqual(second.closed, null, "one close failure does not skip another socket");
    assert.deepEqual((await Promise.all(reads)).map(({ status }) => status), [499, 499]);
});
