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
    EntryData,
    ReadStatement,
    SendStatement,
    EditStatement,
    KillStatement,
    UrlPath,
} from "@plurnk/plurnk-schemes";
import Http from "./Http.ts";
import type { RenderResult } from "./Browser.ts";

// A fake render foundation: returns a canned rendered page, records the call
// (including the request headers threaded through — grammar#46).
const fakeBrowser = (html: string) => {
    const calls: Array<{ url: string; runId: number; headers?: ReadonlyArray<readonly [string, string]> }> = [];
    return {
        calls,
        render: async (url: string, opts: { runId: number; signal?: AbortSignal; headers?: ReadonlyArray<readonly [string, string]> }): Promise<RenderResult> => {
            calls.push({ url, runId: opts.runId, headers: opts.headers });
            return { status: 200, statusText: "OK", headers: [["content-type", "text/html"]], html };
        },
    };
};

// ── conformant ctx + recorder ─────────────────────────────────────────────
const makeCtx = () => {
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let opened: { pathname: string; handle: SubscriptionHandle } | null = null;
    let closed: { reason: string; outcome?: string } | null = null;
    let deleted: string | null = null;
    let wrote: { pathname: string; entry: EntryData } | null = null;
    const seq: string[] = []; // op order — proves create-then-subscribe (http#3)
    const localAbort = new AbortController();

    const entries: EntryCaps = {
        async read() { return { status: 404, entry: null }; },
        async write(pathname, entry) { wrote = { pathname, entry }; seq.push("write"); return { status: 201, created: true, entryId: 1 }; },
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
        async open(pathname, handle) { opened = { pathname, handle }; seq.push("open"); return localAbort.signal; },
        async notifyChunk(channel, chunk, mimetype) { chunks.push({ channel, chunk, mimetype }); },
        async close(reason, outcome) { closed = { reason, outcome }; },
    };
    const crossScheme: CrossSchemeCaps = { _deferred: "see plurnk-service#180 — designed when first cross-scheme COPY/MOVE forces the FROM/TO shape" };

    const ctx: SchemeCtx = {
        sessionId: 1, runId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries, channels, tags, notify, subscriptions, crossScheme,
    };
    return {
        ctx,
        inspect: () => ({ chunks, opened, closed, deleted, wrote, seq }),
        forceCancel: () => opened?.handle.cancel(),
    };
};

const urlTarget = (raw: string, pathname: string, headers?: [string, string][]): UrlPath => ({
    kind: "url", raw, scheme: raw.startsWith("https") ? "https" : "http",
    username: null, password: null, hostname: "example.com", port: null,
    pathname, params: {}, fragment: null,
    ...(headers === undefined ? {} : { headers }),
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
const editStmt = (target: UrlPath | null, body: string | null, lineMarker: EditStatement["lineMarker"] = null): EditStatement => ({
    op: "EDIT", suffix: "EDIT", signal: null, target, lineMarker, body,
    position: { line: 0, column: 0 },
});
const killStmt = (target: UrlPath | null, body: string | null = null): KillStatement => ({
    op: "KILL", suffix: "KILL", signal: null, target, lineMarker: null, body,
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
    // Self-doc for the model's packet listing (deep docs ride plurnk://schemes/http.md).
    assert.equal(Http.manifest.glyph, "🌐");
    // example must be a complete, copy-pasteable op (http#2): the service renders
    // it verbatim into the scheme directory, so a `<<`-less / `::OP`-less form
    // mis-trains small models on op shape. Guard the well-formed `<<OP(…)::OP`
    // heredoc with a matching opener/closer op — catches the regression class
    // without taking a direct grammar dep (siblings pin only @plurnk/plurnk-schemes).
    const example = Http.manifest.example ?? "";
    const op = example.match(/^<<([A-Z]+)\(.+\)::([A-Z]+)$/);
    assert.ok(op, `example must be a well-formed <<OP(…)::OP heredoc, got: ${example}`);
    assert.equal(op[1], op[2], "example opener and closer op must match");
    assert.equal(op[1], "READ");
});

test("manifest: documentation is loaded verbatim from docs/http.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const fromFile = await readFile(new URL("../docs/http.md", import.meta.url), "utf-8");
    assert.equal(Http.manifest.documentation, fromFile);
    assert.match(Http.manifest.documentation ?? "", /^# http\(s\):\/\//);
});

// ── create-then-subscribe (http#3) ────────────────────────────────────────
test("READ: materializes the entry (manifest channels) BEFORE subscribing", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["x"], { "content-type": "text/plain" }), async () => {
        await new Http().read(readStmt(urlTarget("http://example.com/robots.txt", "/robots.txt")), ctx);
    });
    const { wrote, seq } = inspect();
    // write must precede open — open() binds an existing entry; it can't seed channels.
    assert.deepEqual(seq.slice(0, 2), ["write", "open"]);
    assert.equal(wrote?.pathname, "/robots.txt");
    // Seeded channels mirror the manifest: empty content + the seed mimetypes.
    assert.deepEqual(Object.keys(wrote!.entry.channels).sort(), ["body", "header"]);
    assert.deepEqual(wrote!.entry.channels.body, { content: "", mimetype: "application/octet-stream" });
    assert.deepEqual(wrote!.entry.channels.header, { content: "", mimetype: "text/plain" });
    assert.deepEqual(wrote!.entry.tags, []);
});

test("SEND[200]: also materializes the entry before subscribing (shares #fetchStream)", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["ok"], { "content-type": "text/plain" }), async () => {
        await new Http().send(sendStmt(200, urlTarget("https://example.com/p", "/p"), "payload"), ctx);
    });
    const { wrote, seq } = inspect();
    assert.deepEqual(seq.slice(0, 2), ["write", "open"]);
    assert.equal(wrote?.pathname, "/p");
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
    // Byte path labels the body with its real content type (not the seed default).
    assert.ok(chunks.every((c) => c.channel !== "body" || c.mimetype === "text/plain"));
    assert.ok(chunks.some((c) => c.channel === "header" && c.chunk.startsWith("HTTP 200 OK")));
    assert.equal(closed?.reason, "done");
    assert.match(closed?.outcome ?? "", /HTTP 200; \d+ bytes/);
});

test("READ: non-HTML body is labelled with its real content-type", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ['{"a":1}'], { "content-type": "application/json" }), async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/d.json", "/d.json")), ctx);
    });
    const body = inspect().chunks.filter((c) => c.channel === "body");
    assert.equal(body[0]?.mimetype, "application/json");
});

test("READ: an HTML page is rendered — body is the final DOM, labelled text/html", async () => {
    const { ctx, inspect } = makeCtx();
    const browser = fakeBrowser("<html><body>rendered</body></html>");
    // The probe-fetch returns an HTML content-type (a SPA shim); render takes over.
    await withFetch(mockFetch(200, "OK", ["<html><body><div id=root></div></body></html>"], { "content-type": "text/html; charset=utf-8" }), async () => {
        const r = await new Http(browser).read(readStmt(urlTarget("https://example.com/spa", "/spa")), ctx);
        assert.equal(r.status, 102);
    });
    const { chunks, closed } = inspect();
    assert.deepEqual(browser.calls, [{ url: "https://example.com/spa", runId: 1, headers: undefined }]);
    const bodyChunks = chunks.filter((c) => c.channel === "body");
    assert.equal(bodyChunks.length, 1); // single-shot: the whole rendered DOM
    assert.equal(bodyChunks[0].chunk, "<html><body>rendered</body></html>");
    assert.equal(bodyChunks[0].mimetype, "text/html");
    assert.equal(closed?.reason, "done");
    assert.match(closed?.outcome ?? "", /rendered HTTP 200; \d+ chars/);
});

test("SEND[200]: an HTML response is NOT rendered (POST can't be a navigation)", async () => {
    const { ctx, inspect } = makeCtx();
    const browser = fakeBrowser("<html>should not be used</html>");
    await withFetch(mockFetch(200, "OK", ["<html>body</html>"], { "content-type": "text/html" }), async () => {
        await new Http(browser).send(sendStmt(200, urlTarget("https://example.com/p", "/p"), "payload"), ctx);
    });
    assert.equal(browser.calls.length, 0); // render never invoked
    const body = inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join("");
    assert.equal(body, "<html>body</html>"); // streamed raw, not rendered
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

// ── request headers + method verbs (grammar#46) ───────────────────────────
test("READ: target {…} headers are threaded into the fetch", async () => {
    const { ctx } = makeCtx();
    let seenHeaders: RequestInit["headers"];
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenHeaders = init?.headers;
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const target = urlTarget("https://api.x/v1/me", "/v1/me", [["Authorization", "Bearer T"], ["Accept", "application/json"]]);
    await withFetch(probe as typeof fetch, async () => {
        await new Http().read(readStmt(target), ctx);
    });
    assert.deepEqual(seenHeaders, [["Authorization", "Bearer T"], ["Accept", "application/json"]]);
});

test("READ: headers reach the browser render on an HTML GET (authed page renders authed)", async () => {
    const { ctx } = makeCtx();
    const browser = fakeBrowser("<html><body>ok</body></html>");
    const target = urlTarget("https://app.x/dash", "/dash", [["Authorization", "Bearer T"]]);
    await withFetch(mockFetch(200, "OK", ["<html></html>"], { "content-type": "text/html" }), async () => {
        await new Http(browser).read(readStmt(target), ctx);
    });
    assert.deepEqual(browser.calls[0].headers, [["Authorization", "Bearer T"]]);
});

test("EDIT → PUT with the body (method mapping)", async () => {
    const { ctx, inspect } = makeCtx();
    let seenMethod = "", seenBody: unknown = null;
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenMethod = init?.method ?? "GET"; seenBody = init?.body ?? null;
        return new Response("updated", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withFetch(probe as typeof fetch, async () => {
        const r = await new Http().edit(editStmt(urlTarget("https://api.x/thing/42", "/thing/42"), '{"done":true}'), ctx);
        assert.equal(r.status, 102);
    });
    assert.equal(seenMethod, "PUT");
    assert.equal(seenBody, '{"done":true}');
    assert.equal(inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join(""), "updated");
});

test("EDIT: a <L> line marker is rejected — http PUT replaces the whole resource", async () => {
    const { ctx } = makeCtx();
    const r = await new Http().edit(editStmt(urlTarget("https://api.x/thing/42", "/thing/42"), "x", { marks: [1] } as NonNullable<EditStatement["lineMarker"]>), ctx);
    assert.equal(r.status, 400);
    assert.equal(r.error?.kind, "no_line_edit");
});

test("KILL → DELETE (method mapping); distinct from SEND[410] cache drop", async () => {
    const { ctx } = makeCtx();
    let seenMethod = "";
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenMethod = init?.method ?? "GET";
        return new Response(null, { status: 204, statusText: "No Content" });
    };
    await withFetch(probe as typeof fetch, async () => {
        const r = await new Http().kill(killStmt(urlTarget("https://api.x/thing/42", "/thing/42")), ctx);
        assert.equal(r.status, 102);
    });
    assert.equal(seenMethod, "DELETE");
});

// ── hostile-host rewrite (schemes-http#4) ──────────────────────────────────
test("GitHub blob → raw.githubusercontent rewrite (code wants source, not the SPA)", async () => {
    const { ctx } = makeCtx();
    let seenUrl = "";
    const probe = async (url: string | URL | Request) => {
        seenUrl = String(url);
        return new Response("// source", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const blob = "https://github.com/nodejs/node/blob/main/src/node_version.h";
    await withFetch(probe as typeof fetch, async () => {
        await new Http().read(readStmt(urlTarget(blob, "/nodejs/node/blob/main/src/node_version.h")), ctx);
    });
    assert.equal(seenUrl, "https://raw.githubusercontent.com/nodejs/node/main/src/node_version.h");
});

test("GitHub blob rewrite preserves a slash-bearing branch ref", async () => {
    const { ctx } = makeCtx();
    let seenUrl = "";
    const probe = async (url: string | URL | Request) => { seenUrl = String(url); return new Response("x", { status: 200 }); };
    const blob = "https://github.com/o/r/blob/feature/foo/src/x.js";
    await withFetch(probe as typeof fetch, async () => {
        await new Http().read(readStmt(urlTarget(blob, "/o/r/blob/feature/foo/src/x.js")), ctx);
    });
    assert.equal(seenUrl, "https://raw.githubusercontent.com/o/r/feature/foo/src/x.js");
});

test("non-GitHub URL is fetched verbatim (no rewrite)", async () => {
    const { ctx } = makeCtx();
    let seenUrl = "";
    const probe = async (url: string | URL | Request) => { seenUrl = String(url); return new Response("ok", { status: 200 }); };
    await withFetch(probe as typeof fetch, async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/x", "/x")), ctx);
    });
    assert.equal(seenUrl, "https://example.com/x");
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
