// Conformance tests for the Http scheme. Drives it through a fully conformant
// in-memory SchemeCtx (mirroring the contract test pattern in plurnk-schemes'
// own ctx.test.ts) plus a mock global.fetch — so we exercise the real
// subscription lifecycle (open → notifyChunk → close) and the SEND verb
// dispatch without a network or a database.

import test from "node:test";
import { strict as assert } from "node:assert";
import type {
    SchemeCtx,
    SubscriptionHandle,
    EntryCaps,
    ChannelCaps,
    TagCaps,
    NotifyCaps,
    SubscriptionCaps,
    CrossSchemeCaps,
} from "@plurnk/plurnk-schemes";
import type { ReadStatement, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Http from "./Http.ts";

// ── conformant ctx + recorder ─────────────────────────────────────────────
const makeCtx = () => {
    const chunks: Array<{ channel: string; chunk: string }> = [];
    let opened: { pathname: string; handle: SubscriptionHandle } | null = null;
    let closed: { reason: string; outcome?: string } | null = null;
    let deleted: string | null = null;
    const localAbort = new AbortController();

    const entries: EntryCaps = {
        async read() { return { status: 404, entry: null }; },
        async write() { return { status: 201, created: true, entryId: 1 }; },
        async delete(pathname) { deleted = pathname; return { status: 200 }; },
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
    const subscriptions: SubscriptionCaps = {
        async open(pathname, handle) { opened = { pathname, handle }; return localAbort.signal; },
        async notifyChunk(channel, chunk) { chunks.push({ channel, chunk }); },
        async close(reason, outcome) { closed = { reason, outcome }; },
    };
    const crossScheme: CrossSchemeCaps = { _deferred: "see plurnk-service#180 — designed when first cross-scheme COPY/MOVE forces the FROM/TO shape" };

    const ctx: SchemeCtx = {
        sessionId: 1, runId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries, channels, tags, notify, subscriptions, crossScheme,
    };
    return {
        ctx,
        inspect: () => ({ chunks, opened, closed, deleted }),
        forceCancel: () => opened?.handle.cancel(),
    };
};

const urlTarget = (raw: string, pathname: string): UrlPath => ({
    kind: "url", raw, scheme: raw.startsWith("https") ? "https" : "http",
    username: null, password: null, hostname: "example.com", port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (target: UrlPath | null): ReadStatement => ({
    op: "READ", suffix: "READ", signal: null, target, lineMarker: null, body: null,
    position: { line: 0, column: 0 },
});
const sendStmt = (signal: number, target: UrlPath | null, body?: string): SendStatement => ({
    op: "SEND", suffix: "SEND", signal, target, lineMarker: null,
    body: body === undefined ? null : { raw: body, json: null },
    position: { line: 0, column: 0 },
});

// Mock fetch: a streaming Response over the given chunks.
const mockFetch = (status: number, statusText: string, bodyChunks: string[], headers: Record<string, string> = {}) => {
    const enc = new TextEncoder();
    const stream = bodyChunks.length === 0 ? null : new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of bodyChunks) controller.enqueue(enc.encode(c));
            controller.close();
        },
    });
    return async () => new Response(stream, { status, statusText, headers });
};

const withFetch = async (impl: typeof fetch | (() => Promise<Response>), fn: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl as typeof fetch;
    try { await fn(); } finally { globalThis.fetch = original; }
};

// ── manifest ──────────────────────────────────────────────────────────────
test("manifest: name http, default channel body, requiresWeb, network-volatile", () => {
    assert.equal(Http.manifest.name, "http");
    assert.equal(Http.manifest.defaultChannel, "body");
    assert.equal(Http.manifest.flags?.requiresWeb, true);
    assert.equal(Http.manifest.volatile, true);
    assert.deepEqual(Object.keys(Http.manifest.channels).sort(), ["body", "header"]);
});

// ── READ streaming ────────────────────────────────────────────────────────
test("READ: streams response body into the body channel and closes done", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["hello ", "world"], { "content-type": "text/plain" }), async () => {
        const r = await new Http().read(readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 102); // Processing — streaming subscription
    });
    const { chunks, opened, closed } = inspect();
    assert.equal(opened?.pathname, "/x");
    const body = chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join("");
    assert.equal(body, "hello world");
    assert.ok(chunks.some((c) => c.channel === "header" && c.chunk.startsWith("HTTP 200 OK")));
    assert.equal(closed?.reason, "done");
    assert.match(closed?.outcome ?? "", /HTTP 200; \d+ bytes/);
});

test("READ: non-url target → 400 with a scheme:http TelemetryEvent", async () => {
    const { ctx } = makeCtx();
    const r = await new Http().read(readStmt(null), ctx);
    assert.equal(r.status, 400);
    assert.equal(r.error?.source, "scheme:http");
});

test("READ: empty response body closes done without body chunks", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(204, "No Content", []), async () => {
        const r = await new Http().read(readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 102);
    });
    const { chunks, closed } = inspect();
    assert.equal(chunks.filter((c) => c.channel === "body").length, 0);
    assert.equal(closed?.reason, "done");
});

test("READ: network failure → close error + 502", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
        const r = await new Http().read(readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 502);
        assert.equal(r.error?.source, "scheme:http");
    });
    assert.equal(inspect().closed?.reason, "error");
});

// ── SEND verbs ────────────────────────────────────────────────────────────
test("SEND[200]: POSTs the body and streams the response", async () => {
    const { ctx, inspect } = makeCtx();
    let seenMethod = "", seenBody: unknown = null;
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenMethod = init?.method ?? "GET"; seenBody = init?.body ?? null;
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("ok")); c.close(); } }), { status: 200, statusText: "OK" });
    };
    await withFetch(probe as typeof fetch, async () => {
        const r = await new Http().send(sendStmt(200, urlTarget("https://example.com/p", "/p"), "payload"), ctx);
        assert.equal(r.status, 102);
    });
    assert.equal(seenMethod, "POST");
    assert.equal(seenBody, "payload");
    assert.equal(inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join(""), "ok");
});

test("SEND[410]: deletes the cached entry", async () => {
    const { ctx, inspect } = makeCtx();
    const r = await new Http().send(sendStmt(410, urlTarget("http://example.com/x", "/x")), ctx);
    assert.equal(r.status, 200);
    assert.equal(inspect().deleted, "/x");
});

test("SEND[499]: scheme-level no-op (engine routes cancel to the handle)", async () => {
    const { ctx } = makeCtx();
    const r = await new Http().send(sendStmt(499, urlTarget("http://example.com/x", "/x")), ctx);
    assert.equal(r.status, 200);
});

test("SEND with an uninterpreted status → 501", async () => {
    const { ctx } = makeCtx();
    const r = await new Http().send(sendStmt(418, urlTarget("http://example.com/x", "/x")), ctx);
    assert.equal(r.status, 501);
    assert.equal(r.error?.source, "scheme:http");
});

// ── cancellation ──────────────────────────────────────────────────────────
test("force-cancel via the SubscriptionHandle aborts the fetch → 499", async () => {
    const { ctx, inspect, forceCancel } = makeCtx();
    // A fetch that rejects when its signal aborts; we trip it via the handle.
    const hangThenAbort = async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            // trip the cancel on next tick
            queueMicrotask(() => forceCancel());
        });
    };
    await withFetch(hangThenAbort as typeof fetch, async () => {
        const r = await new Http().read(readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 499);
        assert.equal(r.error?.kind, "aborted");
    });
    assert.equal(inspect().closed?.reason, "error");
    assert.equal(inspect().closed?.outcome, "aborted");
});
