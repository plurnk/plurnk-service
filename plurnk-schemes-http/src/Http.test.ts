// Conformance tests for the Http scheme. Drives it through a fully conformant
// in-memory SchemeCtx (mirroring the contract test pattern in plurnk-schemes'
// own ctx.test.ts) plus a mock global.fetch — so we exercise the real
// subscription lifecycle (open → notifyChunk → close) and the SEND verb
// dispatch without a network or a database.

import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import {
    MimetypeClassifier,
    ProjectionInputLimitError,
    Results,
    type EntryStorageReadResult,
    type EntryStorageWriteResult,
    type SchemeResult,
    type EntryReadResult,
    type SchemeCtx,
    type SubscriptionHandle,
    type EntryCaps,
    type ChannelCaps,
    type TagCaps,
    type NotifyCaps,
    type ProjectionCaps,
    type SubscriptionCaps,
    type StreamSubscription,
    type EntryData,
    type ChannelState,
    type StoredEntryData,
    type ReadStatement,
    type SendStatement,
    type EditStatement,
    type KillStatement,
    type FindStatement,
    type UrlPath,
} from "@plurnk/plurnk-schemes";
import Http from "./Http.ts";
import type { RenderResult } from "./Browser.ts";
import Guard from "./Guard.ts";
import WebFetcher from "./WebFetcher.ts";

// A fake render foundation: returns a canned rendered page, records the call
// including ordered request-header metadata {§op-surface}.
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

const failingBrowser = (cause: Error) => ({
    async render(): Promise<RenderResult> {
        throw cause;
    },
});

const projectionCaps = (overrides: Partial<ProjectionCaps> = {}): ProjectionCaps => ({
    async readable(content, mimetype) {
        const text = content.replace(/<[^>]+>/g, "").trim();
        return text.length > 0 ? {
            content: text,
            mimetype: "text/markdown",
            sourceMimetype: mimetype,
            projectionIdentity: `test:${mimetype}`,
        } : null;
    },
    async readableBytes() { return null; },
    async identity(mimetype) { return `test:${mimetype}`; },
    async isBinary(mimetype) { return MimetypeClassifier.isBinary(mimetype); },
    ...overrides,
});

// ── conformant ctx + recorder ─────────────────────────────────────────────
interface CtxOverrides {
    readonly read?: (pathname: string) => Promise<EntryStorageReadResult>;
    readonly write?: (pathname: string, entry: EntryData) => Promise<EntryStorageWriteResult>;
    readonly delete?: (pathname: string) => Promise<SchemeResult>;
    readonly operationRead?: (statement: ReadStatement) => Promise<EntryReadResult>;
    readonly projection?: ProjectionCaps;
    readonly signal?: AbortSignal;
}

const makeCtx = (priorEntry: StoredEntryData | null = null, overrides: CtxOverrides = {}) => {
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let opened: { pathname: string; handle: SubscriptionHandle; publishedChannel?: string } | null = null;
    type ClosedSubscription = { result: Parameters<SubscriptionCaps["close"]>[0]; summary?: string };
    let closed: ClosedSubscription | null = null;
    const settled = Promise.withResolvers<ClosedSubscription>();
    let deleted: string | null = null;
    let wrote: { pathname: string; entry: EntryData } | null = null;
    let observedStorageRead: string | null = null;
    let observedRead: ReadStatement | null = null;
    const seq: string[] = []; // {§http-lifecycle} operation order
    const localAbort = new AbortController();

    const entries: EntryCaps = {
        operations: {
            async editBatch() { return { status: 501, entryId: null, channel: null }; },
            async read(statement) {
                observedRead = statement;
                if (overrides.operationRead !== undefined) return overrides.operationRead(statement);
                return { status: 200, content: "selected lines", mimetype: "text/markdown", channel: "body" };
            },
            async find() { return { status: 501, content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] }; },
            async send() { return { status: 501 }; },
        },
        async read(pathname) {
            observedStorageRead = pathname;
            if (overrides.read !== undefined) return overrides.read(pathname);
            return priorEntry === null
                ? Results.failure(
                    "scheme:test",
                    "entry-not-found",
                    404,
                    `No entry exists at ${pathname}.`,
                    { entry: null },
                ) as EntryStorageReadResult
                : Results.assert({ status: 200, entry: priorEntry });
        },
        async write(pathname, entry) {
            wrote = { pathname, entry };
            seq.push("write");
            if (overrides.write !== undefined) return overrides.write(pathname, entry);
            return { status: 201, created: true, entryId: 1 };
        },
        async delete(pathname) {
            deleted = pathname;
            if (overrides.delete !== undefined) return overrides.delete(pathname);
            return { status: 200 };
        },
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
    const projection = overrides.projection ?? projectionCaps();
    let current: StreamSubscription | null = null;
    const notifyChunk: StreamSubscription["notifyChunk"] = async (channel, chunk, mimetype) => {
        chunks.push({ channel, chunk, mimetype });
    };
    const close: StreamSubscription["close"] = async (result, summary) => {
        closed = { result, summary };
        settled.resolve(closed);
    };
    const subscriptions: SubscriptionCaps = {
        async open(pathname, handle, options) {
            opened = { pathname, handle, ...options };
            seq.push("open");
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
        workspaceId: 1, workerId: 1, loopId: 1, turnId: 1, writer: "model", signal: overrides.signal,
        entries, channels, tags, notify, projection, subscriptions,
    };
    return {
        ctx,
        inspect: () => ({ chunks, opened, closed, deleted, wrote, observedStorageRead, observedRead, seq }),
        forceCancel: () => opened?.handle.cancel(),
        awaitClosed: () => settled.promise,
    };
};

const urlTarget = (raw: string, pathname: string, headers?: [string, string][], fragment: string | null = null): UrlPath => {
    const url = new URL(raw);
    return {
        kind: "url", raw, scheme: url.protocol.slice(0, -1),
        username: url.username || null, password: url.password || null,
        hostname: url.hostname || null, port: url.port === "" ? null : Number(url.port),
        pathname, query: url.search === "" ? null : url.search.slice(1), fragment,
        ...(headers === undefined ? {} : { headers }),
    };
};

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
const mockFetch = (
    status: number,
    statusText: string,
    bodyChunks: ReadonlyArray<string | Uint8Array>,
    headers: Record<string, string> = {},
) => {
    const enc = new TextEncoder();
    const stream = bodyChunks.length === 0 ? null : new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of bodyChunks) {
                controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
            }
            controller.close();
        },
    });
    return async () => new Response(stream, { status, statusText, headers });
};

const withFetch = async (
    impl: typeof fetch | (() => Promise<Response>),
    fn: () => Promise<void>,
    allowAllTargets = true,
) => {
    const original = globalThis.fetch;
    const publicUrl = allowAllTargets ? mock.method(Guard, "isPublicUrl", async () => true) : null;
    globalThis.fetch = impl as typeof fetch;
    try { await fn(); } finally {
        globalThis.fetch = original;
        publicUrl?.mock.restore();
    }
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── manifest ──────────────────────────────────────────────────────────────
test("manifest: name http, default channel body, requiresWeb, network-volatile", () => {
    assert.equal(Http.manifest.name, "http");
    assert.equal(Http.manifest.defaultChannel, "body");
    assert.equal(Http.manifest.flags?.requiresWeb, true);
    assert.equal(Http.manifest.volatile, true);
    assert.deepEqual(Object.keys(Http.manifest.channels).sort(), ["body", "header", "html"]);
    // Self-doc for the model's packet listing (deep docs ride worker://plurnk/docs/http.md).
    // The manifest example must be one complete copy-pasteable operation.
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

test("prepareFind materializes an exact URL through the checked readable path", async () => {
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

test("prepareFind persists a readable binary projection with source and projection evidence", async () => {
    const projection = projectionCaps({
        async isBinary(mimetype) { return mimetype === "application/pdf"; },
        async readableBytes(chunks, mimetype) {
            const bytes: number[] = [];
            for await (const chunk of chunks) bytes.push(...chunk);
            assert.deepEqual(bytes, [1, 2, 3]);
            return {
                content: "projected PDF",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "pdf-reader-v2",
            };
        },
    });
    const { ctx, inspect } = makeCtx(null, { projection });
    await withFetch(mockFetch(200, "OK", [Uint8Array.of(1, 2, 3)], {
        "content-type": "application/pdf",
        "x-plurnk-projection-id": "origin-spoof",
    }), async () => {
        const result = await new Http().prepareFind(
            findStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
            ctx,
        );
        assert.equal(result.status, 201);
    });

    assert.deepEqual(inspect().wrote?.entry.channels.body, {
        content: "projected PDF",
        mimetype: "text/markdown",
    });
    const header = inspect().wrote?.entry.channels.header?.content ?? "";
    assert.match(header, /^content-type: application\/pdf$/m);
    assert.equal(
        [...header.matchAll(/^x-plurnk-projection-id:[ \t]*(.*)$/gim)].at(-1)?.[1],
        "pdf-reader-v2",
        "package projection evidence wins over an origin field of the same name",
    );
});

test("prepareFind reports the binary input ceiling as a typed 413 without persisting bytes", async (t) => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3, 4)); },
        cancel() { cancelled = true; },
    });
    const projection = projectionCaps({
        async isBinary() { return true; },
        async readableBytes() {
            throw new ProjectionInputLimitError({
                mimetype: "application/pdf",
                maximumBytes: 3,
                observedBytes: 4,
            });
        },
    });
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const { ctx, inspect } = makeCtx(null, { projection });
    let result: Awaited<ReturnType<Http["prepareFind"]>> | undefined;
    await withFetch(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "application/pdf" },
    }), async () => {
        result = await new Http().prepareFind(
            findStmt(urlTarget("https://example.com/large.pdf", "/large.pdf")),
            ctx,
        );
    });

    assert.equal(result?.status, 413);
    assert.equal(result?.problem?.type, "https://problems.plurnk.dev/scheme/http/projection-input-limit");
    assert.equal(result?.problem?.mimetype, "application/pdf");
    assert.equal(result?.problem?.maximumBytes, 3);
    assert.equal(result?.problem?.observedBytes, 4);
    assert.equal(result?.problem?.retryable, false);
    assert.equal(cancelled, true);
    assert.equal(inspect().wrote, null);
    assert.equal(diagnostics.length, 0, "an enforced input ceiling is not an internal defect");
});

test("prepareFind treats XHTML and a present empty projection as successful materialization", async () => {
    const projection = projectionCaps({
        async readable(_content, mimetype) {
            return {
                content: "",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: `test:${mimetype}`,
            };
        },
    });
    const { ctx, inspect } = makeCtx(null, { projection });
    const browser = fakeBrowser("<p>wrong fallback</p>");
    await withFetch(
        mockFetch(200, "OK", ["<html><body></body></html>"], { "content-type": "application/xhtml+xml" }),
        async () => {
            const result = await new Http(browser).prepareFind(
                findStmt(urlTarget("https://example.com/empty.xhtml", "/empty.xhtml")),
                ctx,
            );
            assert.equal(result.status, 201);
        },
    );
    assert.equal(browser.calls.length, 0);
    assert.deepEqual(inspect().wrote?.entry.channels.body, { content: "", mimetype: "text/markdown" });
    assert.deepEqual(inspect().wrote?.entry.channels.html, {
        content: "<html><body></body></html>",
        mimetype: "application/xhtml+xml",
    });
});

test("prepareFind reports an absent final HTML projection as 422", async () => {
    const projection = projectionCaps({ async readable() { return null; } });
    const { ctx, inspect } = makeCtx(null, { projection });
    const browser = fakeBrowser("<html><body><div></div></body></html>");
    await withFetch(
        mockFetch(200, "OK", ["<html><body><div></div></body></html>"], { "content-type": "text/html" }),
        async () => {
            const result = await new Http(browser).prepareFind(
                findStmt(urlTarget("https://example.com/empty", "/empty")),
                ctx,
            );
            assert.equal(result.status, 422);
            assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/http/no-readable-projection");
        },
    );
    assert.equal(browser.calls.length, 1);
    assert.equal(inspect().wrote, null);
});

test("prepareFind reports a projection exception as 500 and logs its cause", async (t) => {
    const cause = new Error("reader implementation failed");
    const projection = projectionCaps({ async readable() { throw cause; } });
    const { ctx, inspect } = makeCtx(null, { projection });
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    await withFetch(
        mockFetch(200, "OK", ["<html><body>page</body></html>"], { "content-type": "text/html" }),
        async () => {
            const result = await new Http(fakeBrowser("unused")).prepareFind(
                findStmt(urlTarget("https://example.com/projection", "/projection")),
                ctx,
            );
            assert.equal(result.status, 500);
            assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/http/projection-failed");
            assert.equal(result.problem?.stage, "projection");
            assert.equal(result.problem?.retryable, false);
            assert.doesNotMatch(result.problem?.detail ?? "", /reader implementation failed/);
        },
    );
    assert.equal(inspect().wrote, null);
    assert.equal((diagnostics[0]?.[1] as { error?: Error })?.error?.cause, cause);
});

test("prepareFind reports a lazy-render exception as a retryable 502", async (t) => {
    const cause = new Error("browser navigation failed");
    const projection = projectionCaps({ async readable() { return null; } });
    const { ctx, inspect } = makeCtx(null, { projection });
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    await withFetch(
        mockFetch(200, "OK", ["<html><body></body></html>"], { "content-type": "text/html" }),
        async () => {
            const result = await new Http(failingBrowser(cause)).prepareFind(
                findStmt(urlTarget("https://example.com/render", "/render")),
                ctx,
            );
            assert.equal(result.status, 502);
            assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/http/render-failed");
            assert.equal(result.problem?.stage, "render");
            assert.equal(result.problem?.retryable, true);
        },
    );
    assert.equal(inspect().wrote, null);
    assert.equal((diagnostics[0]?.[1] as { error?: Error })?.error?.cause, cause);
});

test("prepareFind keeps caller cancellation distinct from lazy-render failure", async (t) => {
    const controller = new AbortController();
    const cause = new Error("render aborted");
    const projection = projectionCaps({ async readable() { return null; } });
    const browser = {
        async render(): Promise<RenderResult> {
            controller.abort();
            throw cause;
        },
    };
    const { ctx } = makeCtx(null, { projection, signal: controller.signal });
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    await withFetch(
        mockFetch(200, "OK", ["<html><body></body></html>"], { "content-type": "text/html" }),
        async () => {
            const result = await new Http(browser).prepareFind(
                findStmt(urlTarget("https://example.com/cancelled", "/cancelled")),
                ctx,
            );
            assert.equal(result.status, 499);
            assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/http/cancelled");
            assert.equal(result.problem?.retryable, false);
        },
    );
    assert.equal(diagnostics.length, 0);
});

test("prepareFind reports caller cancellation during the byte probe as 499", async (t) => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const { ctx, inspect } = makeCtx(null, { signal: controller.signal });
    t.mock.method(Guard, "fetch", async (
        _url: Parameters<typeof Guard.fetch>[0],
        _init: Parameters<typeof Guard.fetch>[1],
        signal: Parameters<typeof Guard.fetch>[2],
    ) => {
        controller.abort(reason);
        signal.throwIfAborted();
        throw new Error("unreachable after abort");
    });
    const result = await new Http().prepareFind(
        findStmt(urlTarget("https://example.com/cancelled-probe", "/cancelled-probe")),
        ctx,
    );
    assert.equal(result.status, 499);
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/http/cancelled");
    assert.equal(result.problem?.retryable, false);
    assert.equal(inspect().wrote, null);
});

test("prepareFind does not relabel an unrelated failure after a later caller abort", async (t) => {
    const controller = new AbortController();
    const failure = new Error("unrelated acquisition defect");
    const { ctx } = makeCtx(null, { signal: controller.signal });
    t.mock.method(WebFetcher.prototype, "fetch", async () => {
        controller.abort(new Error("later cancellation"));
        throw failure;
    });
    await assert.rejects(
        new Http().prepareFind(
            findStmt(urlTarget("https://example.com/failed-probe", "/failed-probe")),
            ctx,
        ),
        (error: unknown) => error === failure,
    );
});

test("prepareFind rewrites acquisition but stores the addressed GitHub identity", async () => {
    const { ctx, inspect } = makeCtx();
    let seenUrl = "";
    const blob = "https://github.com/nodejs/node/blob/main/src/node_version.h";
    await withFetch(async (url) => {
        seenUrl = String(url);
        return new Response("// source", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
        const prepared = await new Http().prepareFind(
            findStmt(urlTarget(blob, "/nodejs/node/blob/main/src/node_version.h")),
            ctx,
        );
        assert.equal(prepared.status, 201);
    });
    assert.equal(seenUrl, "https://raw.githubusercontent.com/nodejs/node/main/src/node_version.h");
    assert.equal(inspect().wrote?.pathname, "/github.com/nodejs/node/blob/main/src/node_version.h");
});

test("prepareFind leaves absent and shared-classified path globs to the entry query", async () => {
    const { ctx, inspect } = makeCtx();
    const http = new Http(fakeBrowser("unused"));
    const absent = await http.prepareFind(findStmt(null), ctx);
    assert.equal(absent.status, 200);
    const star = await http.prepareFind(
        findStmt(urlTarget("https://example.com/docs/*", "/docs/*")),
        ctx,
    );
    assert.equal(star.status, 200);
    let fetched = false;
    await withFetch(async () => {
        fetched = true;
        return new Response("wrong");
    }, async () => {
        const characterClass = await http.prepareFind(
            findStmt(urlTarget("https://example.com/docs/[ab].md", "/docs/[ab].md")),
            ctx,
        );
        assert.equal(characterClass.status, 200);
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
});

test("prepareFind preserves an exact storage-read failure without fetching", async () => {
    const failure = Results.failure(
        "scheme:test",
        "storage-unavailable",
        503,
        "The entry store is unavailable.",
        { entry: null },
        { stage: "storage", retryable: true },
    ) as EntryStorageReadResult;
    const { ctx, inspect } = makeCtx(null, { read: async () => failure });
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        const result = await new Http().prepareFind(
            findStmt(urlTarget("https://example.com/x", "/x")),
            ctx,
        );
        assert.deepEqual(result, { ...failure, shape: "passthrough" });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
});

test("prepareFind preserves an exact storage-write failure", async () => {
    const failure = Results.failure(
        "scheme:test",
        "storage-read-only",
        503,
        "The entry store is read-only.",
        { created: false, entryId: null },
        { stage: "storage", retryable: false },
    ) as EntryStorageWriteResult;
    const { ctx } = makeCtx(null, { write: async () => failure });
    await withFetch(
        mockFetch(200, "OK", ["body"], { "content-type": "text/plain" }),
        async () => {
            const result = await new Http().prepareFind(
                findStmt(urlTarget("https://example.com/x", "/x")),
                ctx,
            );
            assert.deepEqual(result, { ...failure, shape: "passthrough" });
        },
    );
});

test("prepareFind preserves an unmarked authored entry without network acquisition", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("authored representation", "text/plain", "", undefined, "static"));
    let fetched = false;
    await withFetch(async () => {
        fetched = true;
        return new Response("wrong");
    }, async () => {
        const result = await new Http().prepareFind(
            findStmt(urlTarget("https://example.com/authored", "/authored")),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
});

// ── acquisition lifecycle {§http-lifecycle} ───────────────────────────────
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
    assert.deepEqual(wrote!.entry.channels.body, { content: "", mimetype: "application/octet-stream", state: "active" });
    assert.deepEqual(wrote!.entry.channels.header, { content: "", mimetype: "text/plain", state: "active" });
    assert.equal(wrote!.entry.channels.html?.state, "active");
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

test("READ uses canonical authority/query identity while metadata and fragment stay out of transport", async () => {
    const { ctx, inspect } = makeCtx();
    let seenUrl = "";
    let seenHeaders: HeadersInit | undefined;
    const target = urlTarget(
        "https://example.com:8443/x?b=2&a=1&a=3",
        "/x",
        [["Authorization", "Bearer example"]],
        "body",
    );
    target.raw += "#body{Authorization: Bearer example}";
    await withFetch(async (url, init) => {
        seenUrl = String(url);
        seenHeaders = init?.headers;
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
        const result = await new Http().read(readStmt(target), ctx);
        assert.equal(result.status, 102);
    });
    assert.equal(seenUrl, "https://example.com:8443/x?b=2&a=1&a=3");
    assert.equal(new Headers(seenHeaders).get("Authorization"), "Bearer example");
    assert.equal(inspect().wrote?.pathname, "/example.com:8443/x?b=2&a=1&a=3");
    assert.equal(inspect().opened?.pathname, "/example.com:8443/x?b=2&a=1&a=3");
});

test("SEND[410] distinguishes an explicit empty query from no query", async () => {
    const { ctx, inspect } = makeCtx();
    const target = urlTarget("https://example.com/x", "/x");
    target.query = "";
    const result = await new Http().send(sendStmt(410, target), ctx);
    assert.equal(result.status, 200);
    assert.equal(inspect().deleted, "/example.com/x?");
});

test("HTTP userinfo is rejected without transport or secret-bearing diagnostics", async () => {
    const { ctx } = makeCtx();
    let fetched = false;
    const target = urlTarget("https://alice:secret@example.com/x", "/x");
    await withFetch(async () => {
        fetched = true;
        return new Response("wrong");
    }, async () => {
        const result = await new Http().read(readStmt(target), ctx);
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/http/userinfo-not-allowed");
        assert.equal(result.problem?.target, "https://example.com/x");
        assert.doesNotMatch(JSON.stringify(result), /alice|secret/);
    });
    assert.equal(fetched, false);
});

test("READ/POST/PUT/DELETE: explicit loopback targets use the native transport", async () => {
    const requests: Array<{ url: string; method: string; redirect: RequestRedirect | undefined }> = [];
    await withFetch((async (input, init) => {
        requests.push({
            url: String(input),
            method: init?.method ?? "GET",
            redirect: init?.redirect,
        });
        return new Response("private", {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    }) as typeof fetch, async () => {
        const target = urlTarget("http://127.0.0.1/private", "/private");
        const operations = [
            (http: Http, ctx: SchemeCtx) => http.read(readStmt(target), ctx),
            (http: Http, ctx: SchemeCtx) => http.send(sendStmt(200, target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => http.edit(editStmt(target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => http.kill(killStmt(target), ctx),
        ];
        for (const operation of operations) {
            const { ctx, inspect } = makeCtx();
            assert.equal((await operation(new Http(), ctx)).status, 102);
            assert.equal(inspect().closed?.result.status, 200);
        }
    }, false);
    assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
        { url: "http://127.0.0.1/private", method: "GET" },
        { url: "http://127.0.0.1/private", method: "POST" },
        { url: "http://127.0.0.1/private", method: "PUT" },
        { url: "http://127.0.0.1/private", method: "DELETE" },
    ]);
    assert.ok(requests.every(({ redirect }) => redirect === "follow"));
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

test("scoped READ delegates an auxiliary channel even when the stored body is empty", async () => {
    const statement = readStmt(
        urlTarget("https://example.com/x#header", "/x", undefined, "header"),
        { marks: [2] },
    );
    const selected = Results.assert({
        status: 200,
        content: "content-type: text/plain",
        mimetype: "text/plain",
        channel: "header",
        startLine: 2,
    }) as EntryReadResult;
    const { ctx, inspect } = makeCtx(
        priorEntry("", "text/plain", "HTTP 204 No Content\ncontent-type: text/plain"),
        {
            operationRead: async (observed) => {
                assert.equal(observed.target?.kind, "url");
                assert.equal(observed.target.fragment, "header");
                return selected;
            },
        },
    );
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        assert.deepEqual(await new Http().read(statement, ctx), { ...selected, shape: "passthrough" });
    });
    assert.equal(inspect().observedRead, statement);
    assert.equal(inspect().observedStorageRead, null, "universal READ is the only channel-selection path");
    assert.equal(fetched, false, "a scoped auxiliary-channel observation never enters the network path");
});

test("scoped READ preserves the exact standard-reader failure", async () => {
    const failure = Results.failure(
        "schemes:slicer",
        "range-not-satisfiable",
        416,
        "The requested line range is outside the selected body.",
        { content: null, mimetype: null, channel: null },
        {
            stage: "selection",
            recovery: "Request a range within the reported line bounds.",
            retryable: false,
        },
    ) as EntryReadResult;
    const { ctx } = makeCtx(
        priorEntry("complete page", "text/markdown", ""),
        { operationRead: async () => failure },
    );
    const result = await new Http().read(
        readStmt(urlTarget("https://example.com/x", "/x"), { marks: [30, 100] }),
        ctx,
    );
    assert.deepEqual(result, { ...failure, shape: "passthrough" });
});

test("scoped READ preserves a missing selected-channel failure without acquisition", async () => {
    const failure = Results.failure(
        "scheme:http",
        "entry-not-found",
        404,
        "No entry exists at https://example.com/x.",
        { content: null, mimetype: null, channel: "body" },
        { retryable: false },
    ) as EntryReadResult;
    const { ctx, inspect } = makeCtx(null, { operationRead: async () => failure });
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        const result = await new Http().read(
            readStmt(urlTarget("https://example.com/x", "/x"), { marks: [2, 4] }),
            ctx,
        );
        assert.deepEqual(result, { ...failure, shape: "passthrough" });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().observedStorageRead, null);
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
    await withFetch(mockFetch(200, "OK", ['{"a":1}'], { "content-type": "Application/JSON; charset=utf-8" }), async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/d.json", "/d.json")), ctx);
    });
    const body = inspect().chunks.filter((c) => c.channel === "body");
    assert.equal(body[0]?.mimetype, "application/json");
});

test("READ: textual bytes follow Fetch UTF-8 decoding regardless of charset metadata", async () => {
    const { ctx, inspect } = makeCtx();
    const windows1252 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    await withFetch(mockFetch(200, "OK", [windows1252], {
        "content-type": "text/plain; charset=windows-1252",
    }), async () => {
        assert.equal(
            (await new Http().read(readStmt(urlTarget("https://example.com/legacy.txt", "/legacy.txt")), ctx)).status,
            102,
        );
    });

    assert.equal(
        inspect().chunks.filter(({ channel }) => channel === "body").map(({ chunk }) => chunk).join(""),
        "caf�",
    );
    assert.match(
        inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "",
        /^content-type: text\/plain; charset=windows-1252$/m,
    );
});

test("READ: an unparseable Content-Type is an unknown binary representation", async () => {
    const { ctx, inspect } = makeCtx();
    let result: Awaited<ReturnType<Http["read"]>> | undefined;
    await withFetch(mockFetch(200, "OK", ["not trustworthy"], {
        "content-type": "text/plain garbage",
    }), async () => {
        result = await new Http().read(readStmt(urlTarget("https://example.com/bad", "/bad")), ctx);
    });

    assert.equal(result?.status, 415);
    assert.equal(result?.problem?.mimetype, "application/octet-stream");
    assert.deepEqual(
        inspect().chunks.filter(({ channel }) => channel === "body"),
        [{ channel: "body", chunk: "", mimetype: "application/octet-stream" }],
    );
});

test("SEND[200]: a binary response becomes a typed marker and explicit non-retryable 415", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
        },
        cancel() { cancelled = true; },
    });
    const { ctx, inspect } = makeCtx();
    let result: Awaited<ReturnType<Http["send"]>> | undefined;
    await withFetch(async () => new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "image/png" },
    }), async () => {
        result = await new Http().send(sendStmt(200, urlTarget("https://example.com/logo.png", "/logo.png"), "create"), ctx);
    });

    assert.equal(result?.status, 415);
    assert.equal(result?.problem?.type, "https://problems.plurnk.dev/scheme/http/binary-response-unsupported");
    assert.equal(result?.problem?.mimetype, "image/png");
    assert.equal(result?.problem?.method, "POST");
    assert.equal(result?.problem?.stage, "materialization");
    assert.equal(result?.problem?.retryable, false);
    assert.match(result?.problem?.recovery ?? "", /Do not retry/);
    assert.equal(cancelled, true);
    assert.deepEqual(
        inspect().chunks.filter(({ channel }) => channel === "body"),
        [{ channel: "body", chunk: "", mimetype: "image/png" }],
    );
    assert.equal(inspect().closed?.result.problem, result?.problem);
    assert.match(inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "", /^HTTP 200 OK/m);
});

test("READ: a readable binary response publishes only derived Unicode and projection evidence", async () => {
    const projection = projectionCaps({
        async isBinary(mimetype) { return mimetype === "application/pdf"; },
        async readableBytes(chunks, mimetype) {
            const bytes: number[] = [];
            for await (const chunk of chunks) bytes.push(...chunk);
            assert.deepEqual(bytes, [37, 80, 68, 70]);
            return {
                content: "# projected paper",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "pdf-reader-v3",
            };
        },
    });
    const { ctx, inspect } = makeCtx(null, { projection });
    let result: Awaited<ReturnType<Http["read"]>> | undefined;
    await withFetch(mockFetch(200, "OK", [Uint8Array.of(37, 80, 68, 70)], {
        "content-type": "application/pdf",
    }), async () => {
        result = await new Http().read(
            readStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
            ctx,
        );
    });

    assert.equal(result?.status, 102);
    assert.deepEqual(
        inspect().chunks.filter(({ channel }) => channel === "body"),
        [{ channel: "body", chunk: "# projected paper", mimetype: "text/markdown" }],
    );
    const header = inspect().chunks
        .filter(({ channel }) => channel === "header")
        .map(({ chunk }) => chunk)
        .join("");
    assert.match(header, /^content-type: application\/pdf$/m);
    assert.match(header, /^x-plurnk-projection-id: pdf-reader-v3$/m);
    assert.equal(inspect().closed?.result.status, 200);
});

test("READ: a binary projection input ceiling leaves a typed marker and closes with 413", async (t) => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3, 4)); },
        cancel() { cancelled = true; },
    });
    const projection = projectionCaps({
        async isBinary() { return true; },
        async readableBytes() {
            throw new ProjectionInputLimitError({
                mimetype: "application/pdf",
                maximumBytes: 3,
                observedBytes: 4,
            });
        },
    });
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const { ctx, inspect } = makeCtx(null, { projection });
    let result: Awaited<ReturnType<Http["read"]>> | undefined;
    await withFetch(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "application/pdf" },
    }), async () => {
        result = await new Http().read(
            readStmt(urlTarget("https://example.com/large.pdf", "/large.pdf")),
            ctx,
        );
    });

    assert.equal(result?.status, 413);
    assert.equal(result?.problem?.type, "https://problems.plurnk.dev/scheme/http/projection-input-limit");
    assert.equal(result?.problem?.maximumBytes, 3);
    assert.equal(result?.problem?.observedBytes, 4);
    assert.deepEqual(
        inspect().chunks.filter(({ channel }) => channel === "body"),
        [{ channel: "body", chunk: "", mimetype: "application/pdf" }],
    );
    assert.equal(cancelled, true);
    assert.equal(inspect().closed?.result.problem, result?.problem);
    assert.equal(diagnostics.length, 0);
});

test("READ: an undeclared body is an application/octet-stream marker, not guessed text", async () => {
    const { ctx, inspect } = makeCtx();
    let result: Awaited<ReturnType<Http["read"]>> | undefined;
    await withFetch(async () => new Response(new Uint8Array([0x68, 0x69]), {
        status: 200,
        statusText: "OK",
    }), async () => {
        result = await new Http().read(readStmt(urlTarget("https://example.com/unknown", "/unknown")), ctx);
    });

    assert.equal(result?.status, 415);
    assert.equal(result?.problem?.mimetype, "application/octet-stream");
    assert.deepEqual(
        inspect().chunks.filter(({ channel }) => channel === "body"),
        [{ channel: "body", chunk: "", mimetype: "application/octet-stream" }],
    );
});

// ── server-sent events {§sse} ─────────────────────────────────────────────
const sseBody = (chunks: Array<{ channel: string; chunk: string }>) =>
    chunks.filter((c) => c.channel === "body").map((c) => c.chunk);

test("READ SSE: each event's data becomes one body chunk, framing stripped", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: hello\n\n", "data: world\n\n"], { "content-type": "text/event-stream" }), async () => {
        const r = await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        assert.equal(r.status, 102);
        await awaitClosed();
    });
    const { chunks, closed } = inspect();
    assert.deepEqual(sseBody(chunks), ["hello\n", "world\n"]);
    assert.ok(chunks.every((c) => c.channel !== "body" || c.mimetype === "text/plain"));
    assert.ok(chunks.some((c) => c.channel === "header" && c.chunk.startsWith("HTTP 200 OK")));
    assert.equal(closed?.summary, "SSE stream; 2 events");
});

test("READ SSE: returns 102 after acquisition while the origin stream remains open", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(value) {
            controller = value;
        },
    });
    const { ctx, inspect, awaitClosed } = makeCtx();
    let returned = false;

    await withFetch(async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    }), async () => {
        const read = new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        void read.then(() => { returned = true; });
        await flush();
        const returnedBeforeClose = returned;
        controller.enqueue(encoder.encode("data: after return\n\n"));
        controller.close();
        assert.equal((await read).status, 102);
        assert.equal(returnedBeforeClose, true, "READ must return while the acquired SSE body is still open");
        await awaitClosed();
    });

    assert.deepEqual(sseBody(inspect().chunks), ["after return\n"]);
    assert.equal(inspect().closed?.result.status, 200);
});

test("READ SSE: multi-line data joins with \\n into a single event", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: a\ndata: b\n\n"], { "content-type": "text/event-stream; charset=utf-8" }), async () => {
        await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    assert.deepEqual(sseBody(inspect().chunks), ["a\nb\n"]);
});

test("READ SSE: comment and metadata-only frames drop; only data dispatches", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", [": keep-alive\n\n", "event: greet\nid: 7\ndata: payload\n\n"], { "content-type": "text/event-stream" }), async () => {
        await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    const { chunks, closed } = inspect();
    assert.deepEqual(sseBody(chunks), ["payload\n"]);
    assert.equal(closed?.summary, "SSE stream; 1 events");
});

test("READ SSE: an event split across network chunks reassembles", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: par", "tial\n", "\n"], { "content-type": "text/event-stream" }), async () => {
        await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    assert.deepEqual(sseBody(inspect().chunks), ["partial\n"]);
});

test("READ SSE: CRLF-framed events parse (\\r normalized)", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: crlf\r", "\n\r", "\n"], { "content-type": "text/event-stream" }), async () => {
        await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    assert.deepEqual(sseBody(inspect().chunks), ["crlf\n"]);
});

test("READ SSE: an oversized incomplete event fails the remote stream", async () => {
    const previous = process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS;
    process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS = "8";
    try {
        const { ctx, inspect, awaitClosed } = makeCtx();
        await withFetch(mockFetch(200, "OK", ["data: this event never terminates"], { "content-type": "text/event-stream" }), async () => {
            const result = await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
            assert.equal(result.status, 102);
            const terminal = await awaitClosed();
            assert.equal(terminal.result.status, 502);
            assert.match(terminal.result.problem?.detail ?? "", /max buffer size of 8/);
        });
        assert.equal(inspect().closed?.result.status, 502);
        assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.dev/scheme/http/fetch-failed");
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS;
        else process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS = previous;
    }
});

test("READ SSE: cancellation after acquisition settles the retained stream at 499", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
    });
    const { ctx, forceCancel, awaitClosed } = makeCtx();

    await withFetch(async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    }), async () => {
        const initial = await new Http().read(readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        assert.equal(initial.status, 102);
        await forceCancel();
        controller.error(new DOMException("aborted", "AbortError"));
        const terminal = await awaitClosed();
        assert.equal(terminal.result.status, 499);
        assert.equal(terminal.result.problem?.type, "https://problems.plurnk.dev/scheme/http/cancelled");
    });
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

test("READ: a present empty rendered projection succeeds and retains its HTML evidence", async () => {
    const projection = projectionCaps({
        async readable(_content, mimetype) {
            return {
                content: "",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: `test:${mimetype}`,
            };
        },
    });
    const { ctx, inspect } = makeCtx(null, { projection });
    const html = "<html><body></body></html>";
    const browser = fakeBrowser(html);
    await withFetch(
        mockFetch(200, "OK", [html], { "content-type": "text/html" }),
        async () => {
            const result = await new Http(browser).read(
                readStmt(urlTarget("https://example.com/empty", "/empty")),
                ctx,
            );
            assert.equal(result.status, 102);
        },
    );
    assert.deepEqual(inspect().chunks.find(({ channel }) => channel === "body"), {
        channel: "body",
        chunk: "",
        mimetype: "text/markdown",
    });
    assert.equal(inspect().chunks.find(({ channel }) => channel === "html")?.chunk, html);
    assert.equal(inspect().closed?.result.status, 200);
});

test("READ: an absent rendered projection returns 422 and retains its HTML evidence", async () => {
    const projection = projectionCaps({ async readable() { return null; } });
    const { ctx, inspect } = makeCtx(null, { projection });
    const html = "<html><body><div></div></body></html>";
    const browser = fakeBrowser(html);
    let result: Awaited<ReturnType<Http["read"]>> | undefined;
    await withFetch(
        mockFetch(200, "OK", [html], { "content-type": "text/html" }),
        async () => {
            result = await new Http(browser).read(
                readStmt(urlTarget("https://example.com/empty", "/empty")),
                ctx,
            );
        },
    );
    assert.equal(result?.status, 422);
    assert.equal(result?.problem?.type, "https://problems.plurnk.dev/scheme/http/no-readable-projection");
    assert.equal(inspect().closed?.result.problem, result?.problem);
    assert.equal(inspect().chunks.find(({ channel }) => channel === "html")?.chunk, html);
    assert.match(inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "", /^HTTP 200 OK/m);
    assert.equal(inspect().chunks.some(({ channel }) => channel === "body"), false);
});

test("READ: a projection exception returns 500, retains evidence, and logs its cause", async (t) => {
    const cause = new Error("reader implementation failed");
    const projection = projectionCaps({ async readable() { throw cause; } });
    const { ctx, inspect } = makeCtx(null, { projection });
    const html = "<html><body>page</body></html>";
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    let result: Awaited<ReturnType<Http["read"]>> | undefined;
    await withFetch(
        mockFetch(200, "OK", [html], { "content-type": "text/html" }),
        async () => {
            result = await new Http(fakeBrowser(html)).read(
                readStmt(urlTarget("https://example.com/projection", "/projection")),
                ctx,
            );
        },
    );
    assert.equal(result?.status, 500);
    assert.equal(result?.problem?.type, "https://problems.plurnk.dev/scheme/http/projection-failed");
    assert.equal(inspect().closed?.result.problem, result?.problem);
    assert.equal(inspect().chunks.find(({ channel }) => channel === "html")?.chunk, html);
    assert.match(inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "", /^HTTP 200 OK/m);
    assert.equal(inspect().chunks.some(({ channel }) => channel === "body"), false);
    assert.equal((diagnostics[0]?.[1] as { error?: Error })?.error?.cause, cause);
});

test("READ: a render exception returns a retryable 502 render failure", async (t) => {
    const cause = new Error("browser navigation failed");
    const { ctx, inspect } = makeCtx();
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    let result: Awaited<ReturnType<Http["read"]>> | undefined;
    await withFetch(
        mockFetch(200, "OK", ["<html></html>"], { "content-type": "text/html" }),
        async () => {
            result = await new Http(failingBrowser(cause)).read(
                readStmt(urlTarget("https://example.com/render", "/render")),
                ctx,
            );
        },
    );
    assert.equal(result?.status, 502);
    assert.equal(result?.problem?.type, "https://problems.plurnk.dev/scheme/http/render-failed");
    assert.equal(result?.problem?.retryable, true);
    assert.equal(inspect().closed?.result.problem, result?.problem);
    assert.equal((diagnostics[0]?.[1] as { error?: Error })?.error?.cause, cause);
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

test("READ preserves an exact storage-read failure before acquisition", async () => {
    const failure = Results.failure(
        "scheme:test",
        "storage-unavailable",
        503,
        "The entry store is unavailable.",
        { entry: null },
        { stage: "storage", retryable: true },
    ) as EntryStorageReadResult;
    const { ctx, inspect } = makeCtx(null, { read: async () => failure });
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        const result = await new Http().read(
            readStmt(urlTarget("https://example.com/x", "/x")),
            ctx,
        );
        assert.deepEqual(result, { ...failure, shape: "passthrough" });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().opened, null);
});

test("READ preserves an exact seed-write failure before acquisition", async () => {
    const failure = Results.failure(
        "scheme:test",
        "storage-read-only",
        503,
        "The entry store is read-only.",
        { created: false, entryId: null },
        { stage: "storage", retryable: false },
    ) as EntryStorageWriteResult;
    const { ctx, inspect } = makeCtx(null, { write: async () => failure });
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        const result = await new Http().read(
            readStmt(urlTarget("https://example.com/x", "/x")),
            ctx,
        );
        assert.deepEqual(result, { ...failure, shape: "passthrough" });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().opened, null);
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

test("READ: network failure bounds caught diagnostics in the exact Problem", async () => {
    const prior = process.env.PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT;
    process.env.PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT = "4";
    try {
        const { ctx, inspect } = makeCtx();
        await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
            const result = await new Http().read(readStmt(urlTarget("http://example.com/x", "/x")), ctx);
            assert.equal(result.problem?.detail, "HTTP GET http://example.com/x failed: ECON...");
            assert.deepEqual(inspect().closed?.result, result);
        });
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT;
        else process.env.PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT = prior;
    }
});

// ── SEND verbs ────────────────────────────────────────────────────────────
test("SEND[200]: POSTs the body and streams the response", async () => {
    const { ctx, inspect } = makeCtx();
    let seenMethod = "", seenBody: unknown = null;
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenMethod = init?.method ?? "GET"; seenBody = init?.body ?? null;
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("ok")); c.close(); } }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/plain" },
        });
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

test("SEND[410] preserves the exact storage-delete failure", async () => {
    const failure = Results.failure(
        "scheme:test",
        "storage-unavailable",
        503,
        "The entry store is unavailable.",
        {},
        { stage: "storage", retryable: true },
    );
    const { ctx } = makeCtx(null, { delete: async () => failure });
    const result = await new Http().send(
        sendStmt(410, urlTarget("http://example.com/x", "/x")),
        ctx,
    );
    assert.deepEqual(result, { ...failure, shape: "passthrough" });
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
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/http/send-status-unsupported");
    assert.equal(r.problem?.stage, "dispatch");
    assert.equal(r.problem?.requestedStatus, 418);
});

// ── request headers and method operations {§op-surface} ───────────────────
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
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/http/line-edit-unsupported");
    assert.equal(r.problem?.recovery, "Remove the line range and submit the complete replacement body.");
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

// ── acquisition target rewrite {§host-rewrite} ────────────────────────────
test("GitHub blob → raw.githubusercontent rewrite (code wants source, not the SPA)", async () => {
    const { ctx, inspect } = makeCtx();
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
    assert.equal(inspect().wrote?.pathname, "/github.com/nodejs/node/blob/main/src/node_version.h");
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

test("POST/PUT/DELETE preserve the addressed GitHub blob target", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const markers: string[] = [];
    const blob = "https://github.com/o/r/blob/main/src/x.js";
    await withFetch(async (url, init) => {
        seen.push({ url: String(url), method: init?.method ?? "GET" });
        return new Response(null, { status: 204 });
    }, async () => {
        const target = urlTarget(blob, "/o/r/blob/main/src/x.js");
        const operations = [
            (http: Http, ctx: SchemeCtx) => http.send(sendStmt(200, target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => http.edit(editStmt(target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => http.kill(killStmt(target), ctx),
        ];
        for (const operation of operations) {
            const { ctx, inspect } = makeCtx();
            assert.equal((await operation(new Http(), ctx)).status, 102);
            const header = inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "";
            markers.push(/^x-plurnk-request-method:[ \t]*(.+)$/im.exec(header)?.[1].trim() ?? "");
        }
    });
    assert.deepEqual(seen, [
        { url: blob, method: "POST" },
        { url: blob, method: "PUT" },
        { url: blob, method: "DELETE" },
    ]);
    assert.deepEqual(markers, ["POST", "PUT", "DELETE"]);
});

// ── conditional revalidation {§revalidation} ──────────────────────────────
const priorEntry = (
    body: string,
    mimetype: string,
    header: string,
    html?: string,
    state: ChannelState = "closed",
): StoredEntryData => ({
    channels: {
        body: { content: body, mimetype, state },
        header: { content: header, mimetype: "text/plain", state },
        ...(html === undefined ? {} : { html: { content: html, mimetype: "text/html", state } }),
    },
    tags: [],
});

const CACHE_VARIANT_HEADER = "x-plurnk-cache-variant";
const stampedHeader = (
    ageMs: number,
    extra = "",
    variant: "default" | "bypass" | null = "default",
) => [
    `HTTP 200 OK${extra}`,
    "x-plurnk-request-method: GET",
    `x-plurnk-fetched-at: ${new Date(Date.now() - ageMs).toISOString()}`,
    ...(variant === null ? [] : [`${CACHE_VARIANT_HEADER}: ${variant}`]),
].join("\n");

test("revalidation: a mutation response cannot satisfy a later GET", async () => {
    const header = [
        "HTTP 200 OK",
        "etag: \"mutation\"",
        "x-plurnk-request-method: POST",
        `x-plurnk-fetched-at: ${new Date().toISOString()}`,
    ].join("\n");
    const { ctx, inspect } = makeCtx(priorEntry("post response", "text/plain", header));
    let conditional = false;
    await withFetch(async (_url, init) => {
        const headers = new Headers(init?.headers);
        conditional = headers.has("if-none-match") || headers.has("if-modified-since");
        return new Response("get response", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/item", "/item")), ctx);
    });
    assert.equal(conditional, false);
    assert.equal(inspect().chunks.filter(({ channel }) => channel === "body").map(({ chunk }) => chunk).join(""), "get response");
});

test("prepareFind reacquires an exact URL whose stored response came from a mutation", async () => {
    const header = [
        "HTTP 200 OK",
        "x-plurnk-request-method: DELETE",
        `x-plurnk-fetched-at: ${new Date().toISOString()}`,
    ].join("\n");
    const { ctx, inspect } = makeCtx(priorEntry("deleted", "text/plain", header));
    let fetched = false;
    await withFetch(async () => {
        fetched = true;
        return new Response("current representation", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
        const result = await new Http().prepareFind(
            findStmt(urlTarget("https://example.com/item", "/item")),
            ctx,
        );
        assert.equal(result.status, 201);
    });
    assert.equal(fetched, true);
    assert.equal(inspect().wrote?.entry.channels.body?.content, "current representation");
});

test("prepareFind reuses only a derived representation produced by the installed projection", async () => {
    for (const [storedIdentity, expectedFetch] of [["pdf-reader-v2", false], ["pdf-reader-v1", true]] as const) {
        const header = [
            "HTTP 200 OK",
            "content-type: application/pdf",
            "x-plurnk-request-method: GET",
            `x-plurnk-fetched-at: ${new Date().toISOString()}`,
            `${CACHE_VARIANT_HEADER}: default`,
            `x-plurnk-projection-id: ${storedIdentity}`,
        ].join("\n");
        const projection = projectionCaps({
            async identity(mimetype) {
                assert.equal(mimetype, "application/pdf");
                return "pdf-reader-v2";
            },
            async isBinary() { return true; },
            async readableBytes(_chunks, mimetype) {
                return {
                    content: "current projection",
                    mimetype: "text/markdown",
                    sourceMimetype: mimetype,
                    projectionIdentity: "pdf-reader-v2",
                };
            },
        });
        const { ctx, inspect } = makeCtx(
            priorEntry("stored projection", "text/markdown", header, undefined, "static"),
            { projection },
        );
        let fetched = false;
        await withFetch(async () => {
            fetched = true;
            return new Response(Uint8Array.of(1), {
                status: 200,
                headers: { "content-type": "application/pdf" },
            });
        }, async () => {
            const result = await new Http().prepareFind(
                findStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
                ctx,
            );
            assert.equal(result.status, expectedFetch ? 201 : 200);
        });
        assert.equal(fetched, expectedFetch);
        assert.equal(inspect().wrote?.entry.channels.body?.content, expectedFetch ? "current projection" : undefined);
    }
});

test("READ revalidation: prior ETag → If-None-Match → 304 serves cached projection + DOM, skips render", async () => {
    const { ctx, inspect } = makeCtx(priorEntry(
        "cached page",
        "text/markdown",
        stampedHeader(120_000, '\netag: "v1"'),
        "<html>cached page</html>",
    ));
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
    const { ctx, inspect } = makeCtx(priorEntry("old", "text/plain", stampedHeader(120_000, '\netag: "v1"')));
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

// ── per-URL TTL at the freshness predicate {§revalidation} ────────────────
const withTtl = async (ttl: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    if (ttl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = ttl;
    try { await fn(); } finally {
        if (prev === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = prev;
    }
};

for (const { name, requestHeaders, responseHeaders, expectedValues } of [
    {
        name: "the default request and a non-varying response",
        requestHeaders: [] as [string, string][],
        responseHeaders: { "content-type": "text/plain" },
        expectedValues: ["default"],
    },
    {
        name: "explicit request metadata",
        requestHeaders: [["Authorization", "Bearer current"]] as [string, string][],
        responseHeaders: { "content-type": "text/plain", [CACHE_VARIANT_HEADER]: "default" },
        expectedValues: ["default", "bypass"],
    },
    {
        name: "an origin Vary field",
        requestHeaders: [] as [string, string][],
        responseHeaders: { "content-type": "text/plain", vary: "Accept-Language" },
        expectedValues: ["bypass"],
    },
]) {
    test(`cache variant: ${name} receives authoritative package evidence`, async () => {
        const { ctx, inspect } = makeCtx();
        await withFetch(async () => new Response("fresh", { status: 200, headers: responseHeaders }), async () => {
            await new Http().read(readStmt(urlTarget(
                "https://example.com/variant",
                "/variant",
                requestHeaders,
            )), ctx);
        });
        const header = inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "";
        const values = [...header.matchAll(new RegExp(`^${CACHE_VARIANT_HEADER}:[ \\t]*(.+)$`, "gim"))]
            .map((match) => match[1].trim());
        assert.deepEqual(values, expectedValues);
        assert.ok(
            header.lastIndexOf(`${CACHE_VARIANT_HEADER}:`) > header.lastIndexOf("x-plurnk-fetched-at:"),
            "package cache evidence follows the acquisition stamp",
        );
    });
}

test("cache variant: explicit request metadata bypasses a TTL-fresh default representation", async () => {
    const { ctx, inspect } = makeCtx(priorEntry(
        "public representation",
        "text/plain",
        stampedHeader(1000, '\netag: "public"'),
    ));
    let fetched = false;
    let conditional = false;
    await withTtl("60000", async () => {
        await withFetch(async (_url, init) => {
            fetched = true;
            const headers = new Headers(init?.headers);
            conditional = headers.has("if-none-match") || headers.has("if-modified-since");
            assert.equal(headers.get("authorization"), "Bearer private");
            return new Response("private representation", { status: 200, headers: { "content-type": "text/plain" } });
        }, async () => {
            await new Http().read(readStmt(urlTarget(
                "https://example.com/account",
                "/account",
                [["Authorization", "Bearer private"]],
            )), ctx);
        });
    });
    assert.equal(fetched, true);
    assert.equal(conditional, false, "validators from the default representation do not cross request metadata");
    assert.equal(
        inspect().chunks.filter(({ channel }) => channel === "body").map(({ chunk }) => chunk).join(""),
        "private representation",
    );
});

test("cache variant: explicit request metadata also bypasses stale validators", async () => {
    const { ctx } = makeCtx(priorEntry(
        "public representation",
        "text/plain",
        stampedHeader(120_000, '\netag: "public"'),
    ));
    let conditional = false;
    await withTtl("0", async () => {
        await withFetch(async (_url, init) => {
            const headers = new Headers(init?.headers);
            conditional = headers.has("if-none-match") || headers.has("if-modified-since");
            return new Response("private representation", { status: 200, headers: { "content-type": "text/plain" } });
        }, async () => {
            await new Http().read(readStmt(urlTarget(
                "https://example.com/account",
                "/account",
                [["Authorization", "Bearer private"]],
            )), ctx);
        });
    });
    assert.equal(conditional, false);
});

for (const [name, header] of [
    ["bypass", stampedHeader(1000, "\nvary: Accept-Language\netag: \"variant\"", "bypass")],
    ["missing legacy", stampedHeader(1000, '\netag: "legacy"', null)],
] as const) {
    test(`cache variant: a ${name} marker cannot supply TTL content or validators`, async () => {
        const { ctx, inspect } = makeCtx(priorEntry("wrong representation", "text/plain", header));
        let fetched = false;
        let conditional = false;
        await withTtl("60000", async () => {
            await withFetch(async (_url, init) => {
                fetched = true;
                const headers = new Headers(init?.headers);
                conditional = headers.has("if-none-match") || headers.has("if-modified-since");
                return new Response("current representation", { status: 200, headers: { "content-type": "text/plain" } });
            }, async () => {
                await new Http().read(readStmt(urlTarget("https://example.com/variant", "/variant")), ctx);
            });
        });
        assert.equal(fetched, true);
        assert.equal(conditional, false);
        assert.equal(
            inspect().chunks.filter(({ channel }) => channel === "body").map(({ chunk }) => chunk).join(""),
            "current representation",
        );
    });
}

test("cache variant: a 304 that introduces Vary retires default reuse", async () => {
    const { ctx, inspect } = makeCtx(priorEntry(
        "cached",
        "text/plain",
        stampedHeader(120_000, '\netag: "v1"'),
    ));
    await withTtl("0", async () => {
        await withFetch(async () => new Response(null, {
            status: 304,
            headers: { vary: "Accept-Language" },
        }), async () => {
            await new Http().read(readStmt(urlTarget("https://example.com/variant", "/variant")), ctx);
        });
    });
    const header = inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "";
    assert.equal(
        [...header.matchAll(new RegExp(`^${CACHE_VARIANT_HEADER}:[ \\t]*(.+)$`, "gim"))].at(-1)?.[1].trim(),
        "bypass",
    );
});

test("prepareFind reacquires request metadata through WebFetcher instead of reusing another variant", async () => {
    const { ctx, inspect } = makeCtx(priorEntry(
        "public",
        "text/plain",
        stampedHeader(1000),
        undefined,
        "static",
    ));
    let authorization = "";
    await withFetch(async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response("private", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
        const result = await new Http().prepareFind(findStmt(urlTarget(
            "https://example.com/account",
            "/account",
            [["Authorization", "Bearer private"]],
        )), ctx);
        assert.equal(result.status, 201);
    });
    assert.equal(authorization, "Bearer private");
    assert.equal(inspect().wrote?.entry.channels.body?.content, "private");
    assert.match(inspect().wrote?.entry.channels.header?.content ?? "", /x-plurnk-cache-variant: bypass$/m);
});

for (const state of ["active", "errored"] as const) {
    test(`prepareFind cannot reuse a ${state} default representation`, async () => {
        const { ctx, inspect } = makeCtx(priorEntry(
            "partial",
            "text/plain",
            stampedHeader(1000),
            undefined,
            state,
        ));
        await withFetch(async () => new Response("complete", {
            status: 200,
            headers: { "content-type": "text/plain" },
        }), async () => {
            assert.equal((await new Http().prepareFind(
                findStmt(urlTarget(`https://example.com/${state}`, `/${state}`)),
                ctx,
            )).status, 201);
        });
        assert.equal(inspect().wrote?.entry.channels.body?.content, "complete");
    });
}

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

test("TTL: a changed projection identity invalidates derived content and its origin validators", async () => {
    const header = `${stampedHeader(
        1000,
        '\ncontent-type: application/pdf\netag: "pdf-v1"',
    )}\nx-plurnk-projection-id: pdf-reader-v1`;
    const projection = projectionCaps({
        async identity(mimetype) {
            assert.equal(mimetype, "application/pdf");
            return "pdf-reader-v2";
        },
        async isBinary() { return true; },
        async readableBytes(_chunks, mimetype) {
            return {
                content: "new projection",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "pdf-reader-v2",
            };
        },
    });
    const { ctx, inspect } = makeCtx(
        priorEntry("old projection", "text/markdown", header),
        { projection },
    );
    let fetched = false;
    let conditional = false;
    await withTtl("60000", async () => {
        await withFetch(async (_url, init) => {
            fetched = true;
            conditional = new Headers(init?.headers).has("if-none-match");
            return new Response(Uint8Array.of(1), {
                status: 200,
                headers: { "content-type": "application/pdf" },
            });
        }, async () => {
            assert.equal(
                (await new Http().read(
                    readStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
                    ctx,
                )).status,
                102,
            );
        });
    });

    assert.equal(fetched, true);
    assert.equal(conditional, false, "a validator cannot certify output from a different projection");
    assert.equal(
        inspect().chunks.filter(({ channel }) => channel === "body").map(({ chunk }) => chunk).join(""),
        "new projection",
    );
});

test("TTL: an exact static WebFetcher materialization is reusable", async () => {
    const { ctx, inspect } = makeCtx(priorEntry(
        "materialized",
        "text/plain",
        stampedHeader(1000),
        undefined,
        "static",
    ));
    let fetched = false;
    await withTtl("60000", async () => {
        await withFetch((async () => { fetched = true; throw new Error("must not fetch"); }) as unknown as typeof fetch, async () => {
            await new Http().read(readStmt(urlTarget("https://example.com/materialized", "/materialized")), ctx);
        });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().chunks.find(({ channel }) => channel === "body")?.chunk, "materialized");
});

test("TTL: a completed empty GET is a reusable representation", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("", "text/plain", stampedHeader(1000)));
    let fetched = false;
    await withTtl("60000", async () => {
        await withFetch((async () => { fetched = true; throw new Error("must not fetch"); }) as unknown as typeof fetch, async () => {
            assert.equal(await new Http().read(readStmt(urlTarget("https://example.com/empty", "/empty")), ctx).then((r) => r.status), 102);
        });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().chunks.filter(({ channel }) => channel === "body").length, 1);
    assert.equal(inspect().chunks.find(({ channel }) => channel === "body")?.chunk, "");
    assert.match(inspect().closed?.summary ?? "", /ttl-fresh; 0 chars/);
});

for (const state of ["active", "errored"] as const) {
    test(`TTL: an ${state} GET seed cannot supply freshness or validators`, async () => {
        const header = stampedHeader(1000, '\netag: "partial"');
        const { ctx } = makeCtx(priorEntry("partial", "text/plain", header, undefined, state));
        let fetched = false;
        let conditional = false;
        await withTtl("60000", async () => {
            await withFetch(async (_url, init) => {
                fetched = true;
                conditional = new Headers(init?.headers).has("if-none-match");
                return new Response("complete", { status: 200, headers: { "content-type": "text/plain" } });
            }, async () => {
                await new Http().read(readStmt(urlTarget(`https://example.com/${state}`, `/${state}`)), ctx);
            });
        });
        assert.equal(fetched, true);
        assert.equal(conditional, false);
    });
}

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

test("READ revalidation: 304 restores a completed empty representation", async () => {
    const header = stampedHeader(120_000, '\netag: "empty"');
    const { ctx, inspect } = makeCtx(priorEntry("", "text/plain", header));
    let seenINM = "";
    await withTtl("60000", async () => {
        await withFetch((async (_url: string | URL | Request, init?: RequestInit) => {
            seenINM = new Headers(init?.headers).get("if-none-match") ?? "";
            return new Response(null, { status: 304, statusText: "Not Modified" });
        }) as typeof fetch, async () => {
            await new Http().read(readStmt(urlTarget("https://example.com/empty", "/empty")), ctx);
        });
    });
    assert.equal(seenINM, '"empty"');
    assert.equal(inspect().chunks.find(({ channel }) => channel === "body")?.chunk, "");
    assert.match(inspect().closed?.summary ?? "", /revalidated 304; 0 chars/);
});

test("TTL: package-appended metadata wins over a same-named origin header", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const stale = new Date(Date.now() - 120_000).toISOString();
    const header = [
        "HTTP 200 OK",
        `x-plurnk-fetched-at: ${future}`,
        "x-plurnk-request-method: GET",
        `x-plurnk-fetched-at: ${stale}`,
        `${CACHE_VARIANT_HEADER}: default`,
    ].join("\n");
    const { ctx } = makeCtx(priorEntry("old", "text/plain", header));
    let fetched = false;
    await withTtl("60000", async () => {
        await withFetch(async () => {
            fetched = true;
            return new Response("fresh", { status: 200, headers: { "content-type": "text/plain" } });
        }, async () => {
            await new Http().read(readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        });
    });
    assert.equal(fetched, true);
});

test("TTL: an unmarked authored entry never supplies GET freshness or validators", async () => {
    const { ctx } = makeCtx(priorEntry(
        "materialized",
        "text/html",
        "HTTP 200 OK\netag: \"m1\"",
        undefined,
        "static",
    ));
    let fetched = false;
    let conditional = false;
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        fetched = true;
        conditional = new Headers(init?.headers).has("if-none-match");
        return new Response("x", { status: 200 });
    };
    await withTtl("60000", async () => {
        await withFetch(probe as typeof fetch, async () => {
            await new Http().read(readStmt(urlTarget("https://example.com/m", "/m")), ctx);
        });
    });
    assert.equal(fetched, true);
    assert.equal(conditional, false);
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

test("GET appends authoritative request-method metadata after origin headers", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(async () => new Response("x", {
        status: 200,
        headers: {
            "content-type": "text/plain",
            "x-plurnk-request-method": "POST",
        },
    }), async () => {
        await new Http().read(readStmt(urlTarget("https://example.com/method", "/method")), ctx);
    });
    const header = inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "";
    assert.deepEqual(
        [...header.matchAll(/^x-plurnk-request-method:[ \t]*(.+)$/gim)].map((match) => match[1].trim()),
        ["POST", "GET"],
    );
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
test("force-cancel via the SubscriptionHandle aborts the fetch -> 499", async () => {
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
        assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/http/cancelled");
        assert.equal(r.problem?.stage, "acquisition");
        assert.equal(r.problem?.retryable, false);
    });
    assert.equal(inspect().closed?.result.status, 499);
    assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.dev/scheme/http/cancelled");
    assert.equal(inspect().closed?.summary, "HTTP GET http://example.com/x was cancelled.");
});
