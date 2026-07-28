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
    ProjectionCaps,
    SubscriptionCaps,
    EntryData,
    ReadStatement,
    SendStatement,
    EditStatement,
    KillStatement,
    FindStatement,
    UrlPath,
} from "@plurnk/plurnk-schemes";
import Http from "./Http.ts";
import type { RenderResult } from "./Browser.ts";

// A fake render foundation: returns a canned rendered page, records the call
// (including the request headers threaded through — grammar#46).
const fakeBrowser = (html: string) => {
    const calls: Array<{ url: string; workerId: number; headers?: ReadonlyArray<readonly [string, string]> }> = [];
    return {
        calls,
        render: async (url: string, opts: { workerId: number; signal?: AbortSignal; headers?: ReadonlyArray<readonly [string, string]> }): Promise<RenderResult> => {
            calls.push({ url, workerId: opts.workerId, headers: opts.headers });
            return { status: 200, statusText: "OK", headers: [["content-type", "text/html"]], html };
        },
    };
};

// ── conformant ctx + recorder ─────────────────────────────────────────────
const makeCtx = (priorEntry: EntryData | null = null) => {
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let opened: { pathname: string; handle: SubscriptionHandle; publishedChannel?: string } | null = null;
    let closed: { result: Parameters<SubscriptionCaps["close"]>[0]; summary?: string } | null = null;
    let deleted: string | null = null;
    let wrote: { pathname: string; entry: EntryData } | null = null;
    let observedRead: ReadStatement | null = null;
    const seq: string[] = []; // op order — proves create-then-subscribe (http#3)
    const localAbort = new AbortController();

    const entries: EntryCaps = {
        operations: {
            async editBatch() { return { status: 501, entryId: null, channel: null }; },
            async read(statement) {
                observedRead = statement;
                return { status: 200, content: "selected lines", mimetype: "text/markdown", channel: "body" };
            },
            async find() { return { status: 501, content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] }; },
            async send() { return { status: 501 }; },
        },
        async read() { return priorEntry === null ? { status: 404, entry: null } : { status: 200, entry: priorEntry }; },
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
    const projection: ProjectionCaps = {
        async readable(content) {
            const text = content.replace(/<[^>]+>/g, "").trim();
            return text.length > 0 ? { content: text, mimetype: "text/markdown" } : null;
        },
    };
    const subscriptions: SubscriptionCaps = {
        async open(pathname, handle, options) { opened = { pathname, handle, ...options }; seq.push("open"); return localAbort.signal; },
        async notifyChunk(channel, chunk, mimetype) { chunks.push({ channel, chunk, mimetype }); },
        async close(result, summary) { closed = { result, summary }; },
    };
    const ctx: SchemeCtx = {
        workspaceId: 1, workerId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries, channels, tags, notify, projection, subscriptions,
    };
    return {
        ctx,
        inspect: () => ({ chunks, opened, closed, deleted, wrote, observedRead, seq }),
        forceCancel: () => opened?.handle.cancel(),
    };
};

const urlTarget = (raw: string, pathname: string, headers?: [string, string][], fragment: string | null = null): UrlPath => ({
    kind: "url", raw, scheme: raw.startsWith("https") ? "https" : "http",
    username: null, password: null, hostname: "example.com", port: null,
    pathname, params: {}, fragment,
    ...(headers === undefined ? {} : { headers }),
});

const readStmt = (target: UrlPath | null, lineMarker: ReadStatement["lineMarker"] = null): ReadStatement => ({
    op: "READ", suffix: "READ", signal: null, target, lineMarker, body: null,
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
const findStmt = (target: UrlPath | null, body: FindStatement["body"] = null): FindStatement => ({
    op: "FIND", suffix: "FIND", signal: null, target, lineMarker: null, body,
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
    assert.deepEqual(Object.keys(Http.manifest.channels).sort(), ["body", "header", "html"]);
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

test("prepareFind materializes an exact URL through the guarded readable path", async () => {
    const { ctx, inspect } = makeCtx();
    const http = new Http(fakeBrowser("<html>browser fallback</html>"));
    const target = urlTarget("https://example.com/dist/index.json", "/dist/index.json");
    await withFetch(
        mockFetch(200, "OK", ['{"version":"24.18.0"}'], { "content-type": "application/json" }),
        async () => {
            const prepared = await http.prepareFind(findStmt(target), ctx);
            assert.equal(prepared.status, 201);
        },
    );
    assert.equal(inspect().wrote?.pathname, "/example.com/dist/index.json");
    assert.equal(inspect().wrote?.entry.channels.body?.content, '{"version":"24.18.0"}');
    assert.equal(inspect().wrote?.entry.channels.body?.mimetype, "application/json");
});

test("prepareFind leaves absent and glob discovery to the shared entry query", async () => {
    const { ctx, inspect } = makeCtx();
    const http = new Http(fakeBrowser("unused"));
    const absent = await http.prepareFind(findStmt(null), ctx);
    assert.equal(absent.status, 200);
    const glob = await http.prepareFind(
        findStmt(urlTarget("https://example.com/docs/*", "/docs/*")),
        ctx,
    );
    assert.equal(glob.status, 200);
    assert.equal(inspect().wrote, null);
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
    assert.equal(wrote?.pathname, "/example.com/robots.txt");
    // Seeded channels mirror the manifest: empty content + the seed mimetypes.
    assert.deepEqual(Object.keys(wrote!.entry.channels).sort(), ["body", "header", "html"]);
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
    assert.equal(wrote?.pathname, "/example.com/p");
});

// ── READ streaming ────────────────────────────────────────────────────────
test("READ: streams response body into the body channel and closes done", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["hello ", "world"], { "content-type": "text/plain" }), async () => {
        const r = await new Http().read(readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 102); // Processing — streaming subscription
    });
    const { chunks, opened, closed } = inspect();
    assert.equal(opened?.pathname, "/example.com/x");
    assert.equal(opened?.publishedChannel, "body", "fragmentless READ publishes only the manifest default");
    const body = chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join("");
    assert.equal(body, "hello world");
    // Byte path labels the body with its real content type (not the seed default).
    assert.ok(chunks.every((c) => c.channel !== "body" || c.mimetype === "text/plain"));
    assert.ok(chunks.some((c) => c.channel === "header" && c.chunk.startsWith("HTTP 200 OK")));
    assert.equal(closed?.result.status, 200);
    assert.match(closed?.summary ?? "", /HTTP 200; \d+ bytes/);
});

test("scoped READ observes the materialized readable entry without refetching", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("complete page", "text/markdown", ""));
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        const statement = readStmt(urlTarget("https://example.com/x", "/x"), { marks: [2, 4] });
        const result = await new Http().read(statement, ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "selected lines");
        assert.equal(inspect().observedRead, statement, "the standard entry reader owns scope semantics");
    });
    assert.equal(fetched, false, "a range observation never re-enters the network path");
    assert.equal(inspect().wrote, null, "the materialized entry is not replaced with a stream seed");
    assert.equal(inspect().opened, null, "no subscription is opened for a stored range");
});

test("scoped READ fails clearly when no readable response has been materialized", async () => {
    const { ctx, inspect } = makeCtx();
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        const result = await new Http().read(
            readStmt(urlTarget("https://example.com/x", "/x"), { marks: [2, 4] }),
            ctx,
        );
        assert.equal(result.status, 409);
        assert.match(result.problem?.detail ?? "", /READ the URL without <scope> first/);
    });
    assert.equal(fetched, false);
    assert.equal(inspect().opened, null);
});

test("READ: an explicit auxiliary fragment publishes that channel instead", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["body"], { "content-type": "text/plain" }), async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/x", "/x", undefined, "header")), ctx);
    });
    assert.equal(inspect().opened?.publishedChannel, "header");
});

test("READ: an unknown channel fails before fetching or subscribing", async () => {
    const { ctx, inspect } = makeCtx();
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("no"); }, async () => {
        const result = await new Http().read(readStmt(urlTarget("https://example.com/x", "/x", undefined, "raw")), ctx);
        assert.equal(result.status, 400);
    });
    assert.equal(fetched, false);
    assert.equal(inspect().opened, null);
});

test("READ: non-HTML body is labelled with its real content-type", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ['{"a":1}'], { "content-type": "application/json" }), async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/d.json", "/d.json")), ctx);
    });
    const body = inspect().chunks.filter((c) => c.channel === "body");
    assert.equal(body[0]?.mimetype, "application/json");
});

// ── SSE (#468) ────────────────────────────────────────────────────────────
const sseBody = (chunks: Array<{ channel: string; chunk: string }>) =>
    chunks.filter((c) => c.channel === "body").map((c) => c.chunk);

test("READ SSE: each event's data becomes one body chunk, framing stripped", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: hello\n\n", "data: world\n\n"], { "content-type": "text/event-stream" }), async () => {
        const r = await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        assert.equal(r.status, 102);
    });
    const { chunks, closed } = inspect();
    assert.deepEqual(sseBody(chunks), ["hello\n", "world\n"]);
    assert.ok(chunks.every((c) => c.channel !== "body" || c.mimetype === "text/plain"));
    assert.ok(chunks.some((c) => c.channel === "header" && c.chunk.startsWith("HTTP 200 OK")));
    assert.equal(closed?.summary, "SSE stream; 2 events");
});

test("READ SSE: multi-line data joins with \\n into a single event", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: a\ndata: b\n\n"], { "content-type": "text/event-stream; charset=utf-8" }), async () => {
        await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
    });
    assert.deepEqual(sseBody(inspect().chunks), ["a\nb\n"]);
});

test("READ SSE: comment and metadata-only frames drop; only data dispatches", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", [": keep-alive\n\n", "event: greet\nid: 7\ndata: payload\n\n"], { "content-type": "text/event-stream" }), async () => {
        await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
    });
    const { chunks, closed } = inspect();
    assert.deepEqual(sseBody(chunks), ["payload\n"]);
    assert.equal(closed?.summary, "SSE stream; 1 events");
});

test("READ SSE: an event split across network chunks reassembles", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: par", "tial\n", "\n"], { "content-type": "text/event-stream" }), async () => {
        await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
    });
    assert.deepEqual(sseBody(inspect().chunks), ["partial\n"]);
});

test("READ SSE: CRLF-framed events parse (\\r normalized)", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: crlf\r", "\n\r", "\n"], { "content-type": "text/event-stream" }), async () => {
        await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
    });
    assert.deepEqual(sseBody(inspect().chunks), ["crlf\n"]);
});

test("READ SSE: an oversized incomplete event fails the remote stream", async () => {
    const previous = process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS;
    process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS = "8";
    try {
        const { ctx, inspect } = makeCtx();
        await withFetch(mockFetch(200, "OK", ["data: this event never terminates"], { "content-type": "text/event-stream" }), async () => {
            const result = await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
            assert.equal(result.status, 502);
            assert.match(result.problem?.detail ?? "", /max buffer size of 8/);
        });
        assert.equal(inspect().closed?.result.status, 502);
        assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.dev/scheme/http/fetch-failed");
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS;
        else process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS = previous;
    }
});

test("READ: rendered HTML archives the DOM while body carries the model-facing projection", async () => {
    const { ctx, inspect } = makeCtx();
    const browser = fakeBrowser("<html><body>rendered</body></html>");
    // The probe-fetch returns an HTML content-type (a SPA shim); render takes over.
    await withFetch(mockFetch(200, "OK", ["<html><body><div id=root></div></body></html>"], { "content-type": "text/html; charset=utf-8" }), async () => {
        const r = await new Http(browser).read(readStmt(urlTarget("https://example.com/spa", "/spa")), ctx);
        assert.equal(r.status, 102);
    });
    const { chunks, closed } = inspect();
    assert.deepEqual(browser.calls, [{ url: "https://example.com/spa", workerId: 1, headers: [] }]);
    const bodyChunks = chunks.filter((c) => c.channel === "body");
    assert.equal(bodyChunks.length, 1);
    assert.equal(bodyChunks[0].chunk, "rendered");
    assert.equal(bodyChunks[0].mimetype, "text/markdown");
    const htmlChunks = chunks.filter((c) => c.channel === "html");
    assert.equal(htmlChunks[0]?.chunk, "<html><body>rendered</body></html>");
    assert.equal(htmlChunks[0]?.mimetype, "text/html");
    assert.equal(closed?.result.status, 200);
    assert.match(closed?.summary ?? "", /rendered HTTP 200; \d+ readable chars/);
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

test("READ: non-url target → 400 with RFC 9457 Problem Details", async () => {
    const { ctx } = makeCtx();
    const r = await new Http().read(readStmt(null), ctx);
    assert.equal(r.status, 400);
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/http/bad-target");
});

test("READ: empty response body closes done without body chunks", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(204, "No Content", []), async () => {
        const r = await new Http().read(readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 102);
    });
    const { chunks, closed } = inspect();
    assert.equal(chunks.filter((c) => c.channel === "body").length, 0);
    assert.equal(closed?.result.status, 200);
});

test("READ: network failure → close error + 502", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
        const r = await new Http().read(readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 502);
        assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/http/fetch-failed");
    });
    assert.equal(inspect().closed?.result.status, 502);
    assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.dev/scheme/http/fetch-failed");
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
    assert.equal(inspect().deleted, "/example.com/x");
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
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/http/unsupported-send");
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
    // Default browser identity rides first when the model supplied no UA block.
    assert.deepEqual(seenHeaders, [["User-Agent", (seenHeaders as [string, string][])[0][1]], ["Authorization", "Bearer T"], ["Accept", "application/json"]]);
    assert.match((seenHeaders as [string, string][])[0][1], /Mozilla.*Chrome/);
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
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/http/no-line-edit");
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

// ── conditional revalidation (service#341) ─────────────────────────────────
const priorEntry = (body: string, mimetype: string, header: string, html?: string): EntryData => ({
    channels: {
        body: { content: body, mimetype },
        header: { content: header, mimetype: "text/plain" },
        ...(html === undefined ? {} : { html: { content: html, mimetype: "text/html" } }),
    },
    tags: [],
});

test("READ revalidation: prior ETag → If-None-Match → 304 serves cached projection + DOM, skips render", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("cached page", "text/markdown", "HTTP 200 OK\netag: \"v1\"", "<html>cached page</html>"));
    const browser = fakeBrowser("<html>SHOULD NOT RENDER</html>");
    let seenINM = "";
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenINM = new Headers(init?.headers).get("if-none-match") ?? "";
        return new Response(null, { status: 304, statusText: "Not Modified" });
    };
    await withFetch(probe as typeof fetch, async () => {
        const r = await new Http(browser).read(readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        assert.equal(r.status, 102); // first-class READ, not a cache status
    });
    assert.equal(seenINM, "\"v1\"");                       // validator sent
    assert.equal(browser.calls.length, 0);                  // 304 → no render
    const body = inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join("");
    assert.equal(body, "cached page");                      // cached body re-served
    assert.equal(inspect().chunks.find((c) => c.channel === "html")?.chunk, "<html>cached page</html>");
    assert.match(inspect().closed?.summary ?? "", /revalidated 304/); // honest in the close summary
});

test("READ revalidation: 200 (changed) re-fetches + streams normally despite a prior entry", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("old", "text/plain", "HTTP 200 OK\netag: \"v1\""));
    await withFetch(mockFetch(200, "OK", ["fresh content"], { "content-type": "text/plain" }), async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/p", "/p")), ctx);
    });
    const body = inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join("");
    assert.equal(body, "fresh content");
    assert.match(inspect().closed?.summary ?? "", /HTTP 200; \d+ bytes/); // normal path, not revalidated
});

test("READ revalidation: no prior entry → no conditional headers, full fetch", async () => {
    const { ctx } = makeCtx(); // 404 on read
    let hadConditional = false;
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        hadConditional = h.has("if-none-match") || h.has("if-modified-since");
        return new Response("body", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withFetch(probe as typeof fetch, async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/x", "/x")), ctx);
    });
    assert.equal(hadConditional, false);
});

// ── per-URL TTL at the freshness predicate (#405, service#333) ─────────────
const stampedHeader = (ageMs: number, extra = "") =>
    `HTTP 200 OK${extra}\nx-plurnk-fetched-at: ${new Date(Date.now() - ageMs).toISOString()}`;
const withTtl = async (ttl: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    if (ttl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = ttl;
    try { await fn(); } finally {
        if (prev === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = prev;
    }
};

test("TTL: fresh stamp serves the stored copy with ZERO round-trips", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("cached page", "text/html", stampedHeader(1000)));
    let fetched = false;
    await withTtl("60000", async () => {
        await withFetch((async () => { fetched = true; throw new Error("must not fetch"); }) as unknown as typeof fetch, async () => {
            const r = await new Http().read(readStmt(urlTarget("https://example.com/p", "/p")), ctx);
            assert.equal(r.status, 102);
        });
    });
    assert.equal(fetched, false); // no network at all — the pre-fetch phase served
    const body = inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join("");
    assert.equal(body, "cached page");
    assert.match(inspect().closed?.summary ?? "", /ttl-fresh/);
});

test("TTL: stale stamp falls through to the conditional GET (revalidates)", async () => {
    const { ctx } = makeCtx(priorEntry("old", "text/plain", stampedHeader(120_000, "\netag: \"v1\"")));
    let seenINM = "";
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenINM = new Headers(init?.headers).get("if-none-match") ?? "";
        return new Response("fresh", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withTtl("60000", async () => {
        await withFetch(probe as typeof fetch, async () => {
            await new Http().read(readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        });
    });
    assert.equal(seenINM, "\"v1\""); // past the window → the 304 phase owns freshness
});

test("TTL: stampless prior entry (execs-materialized) never TTL-serves — revalidates", async () => {
    const { ctx } = makeCtx(priorEntry("materialized", "text/html", "HTTP 200 OK\netag: \"m1\""));
    let fetched = false;
    const probe = async () => { fetched = true; return new Response("x", { status: 200 }); };
    await withTtl("60000", async () => {
        await withFetch(probe as typeof fetch, async () => {
            await new Http().read(readStmt(urlTarget("https://example.com/m", "/m")), ctx);
        });
    });
    assert.equal(fetched, true);
});

test("TTL: explicit 0 disables the window — fresh stamp still revalidates", async () => {
    const { ctx } = makeCtx(priorEntry("cached", "text/plain", stampedHeader(1000, "\netag: \"v1\"")));
    let fetched = false;
    const probe = async () => { fetched = true; return new Response(null, { status: 304 }); };
    await withTtl("0", async () => {
        await withFetch(probe as typeof fetch, async () => {
            await new Http().read(readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        });
    });
    assert.equal(fetched, true);
});

test("TTL: unset crashes naming the var (floor-set knob, no silent default)", async () => {
    const { ctx } = makeCtx(priorEntry("cached", "text/plain", stampedHeader(1000)));
    await withTtl(undefined, async () => {
        await assert.rejects(
            new Http().read(readStmt(urlTarget("https://example.com/p", "/p")), ctx),
            /PLURNK_SCHEMES_HTTP_TTL_MS is unset/,
        );
    });
});

test("stamp: #writeHeader materializes x-plurnk-fetched-at; 304 re-serve refreshes it", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["x"], { "content-type": "text/plain" }), async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/s", "/s")), ctx);
    });
    const header = inspect().chunks.find((c) => c.channel === "header")?.chunk ?? "";
    assert.match(header, /^x-plurnk-fetched-at: \d{4}-/m); // stamped at materialization

    const old = stampedHeader(500_000, "\netag: \"v1\"");
    const { ctx: ctx2, inspect: inspect2 } = makeCtx(priorEntry("cached", "text/plain", old));
    await withTtl("0", async () => {
        await withFetch((async () => new Response(null, { status: 304 })) as unknown as typeof fetch, async () => {
            await new Http().read(readStmt(urlTarget("https://example.com/s", "/s")), ctx2);
        });
    });
    const served = inspect2().chunks.find((c) => c.channel === "header")?.chunk ?? "";
    const oldMs = Date.parse(/x-plurnk-fetched-at: (.+)$/m.exec(old)![1]);
    const newMs = Date.parse(/x-plurnk-fetched-at: (.+)$/m.exec(served)![1]);
    assert.ok(newMs > oldMs, "origin vouched (304) → stamp refreshed");
});

// ── wire identity ───────────────────────────────────────────────────────────
test("byte path sends the browser UA, not Node's automated-client default", async () => {
    const { ctx } = makeCtx();
    let ua = "";
    const probe = async (_u: string | URL | Request, init?: RequestInit) => {
        ua = new Headers(init?.headers).get("user-agent") ?? "";
        return new Response("x", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withFetch(probe as typeof fetch, async () => {
        await new Http().read(readStmt(urlTarget("https://api.example.com/d.json", "/d.json")), ctx);
    });
    assert.match(ua, /Mozilla.*Chrome/);
});

test("a model-supplied User-Agent target block overrides the default identity", async () => {
    const { ctx } = makeCtx();
    let ua = "";
    const probe = async (_u: string | URL | Request, init?: RequestInit) => {
        ua = new Headers(init?.headers).get("user-agent") ?? "";
        return new Response("x", { status: 200 });
    };
    const target = urlTarget("https://api.example.com/x", "/x", [["User-Agent", "curl/8"]]);
    await withFetch(probe as typeof fetch, async () => {
        await new Http().read(readStmt(target), ctx);
    });
    assert.equal(ua, "curl/8");
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
        assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/http/aborted");
    });
    assert.equal(inspect().closed?.result.status, 499);
    assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.dev/scheme/http/aborted");
    assert.equal(inspect().closed?.summary, "aborted");
});
