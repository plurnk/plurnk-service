// Conformance tests for the Http scheme. Drives it through a fully conformant
// in-memory SchemeCtx (mirroring the contract test pattern in plurnk-schemes'
// own ctx.test.ts) plus a mock global.fetch — so we exercise the real
// subscription lifecycle (open → notifyChunk → close) and the SEND verb
// dispatch without a network or a database.

import test, { after, before, beforeEach, mock } from "node:test";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import MaterializerRegistry from "./Materializer.ts";
import {
    MimetypeClassifier,
    NetworkAddress,
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
    type NotifyCaps,
    type ProjectionCaps,
    type SubscriptionCaps,
    type StreamSubscription,
    type EntryData,
    type ChannelState,
    type StoredEntryData,
    type ReadStatement,
    type SendStatement,
    type ResolvedEditStatement,
    type KillStatement,
    type FindStatement,
    type UrlPath,
} from "@plurnk/plurnk-schemes";
import Http from "./Http.ts";
import Guard from "./Guard.ts";
import WebFetcher, {
    CACHE_VARIANT_HEADER,
    MATERIALIZER_ENV,
    MATERIALIZER_ID_HEADER,
} from "./WebFetcher.ts";

const STUB_DIR = resolve(import.meta.dirname, "..", "test", "fixtures", "materializer-stub");

const originalMaterializer = process.env[MATERIALIZER_ENV];
before(async () => {
    await MaterializerRegistry.current().discover({
        packageDirs: [{ dir: STUB_DIR, name: "@plurnk/test-materializer-stub" }],
    });
});
beforeEach(() => {
    delete process.env[MATERIALIZER_ENV];
});
after(() => {
    if (originalMaterializer === undefined) delete process.env[MATERIALIZER_ENV];
    else process.env[MATERIALIZER_ENV] = originalMaterializer;
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
    parseIssues: overrides.parseIssues ?? (async () => undefined),
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
    type ClosedSubscription = {
        result: Parameters<StreamSubscription["close"]>[0];
        summary?: string;
        channelStates?: Parameters<StreamSubscription["close"]>[2];
    };
    let closed: ClosedSubscription | null = null;
    const settled = Promise.withResolvers<ClosedSubscription>();
    let deleted: string | null = null;
    let wrote: { pathname: string; entry: EntryData } | null = null;
    let observedStorageRead: string | null = null;
    let observedRead: ReadStatement | null = null;
    let storedEntry = priorEntry;
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
            async find() { return { status: 501, content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0, matchingPathCount: 0, matchLocationCount: 0 }; },
            async send() { return { status: 501 }; },
        },
        async read(pathname) {
            observedStorageRead = pathname;
            if (overrides.read !== undefined) return overrides.read(pathname);
            return storedEntry === null
                ? Results.failure(
                    "scheme:test",
                    "entry-not-found",
                    404,
                    `No entry exists at ${pathname}.`,
                    { entry: null },
                ) as EntryStorageReadResult
                : Results.assert({ status: 200, entry: storedEntry });
        },
        async write(pathname, entry) {
            wrote = { pathname, entry };
            seq.push("write");
            if (overrides.write !== undefined) return overrides.write(pathname, entry);
            storedEntry = {
                channels: Object.fromEntries(Object.entries(entry.channels).map(([channel, value]) => [
                    channel,
                    { ...value, state: value.state ?? "static" },
                ])),
                ...(entry.attributes === undefined ? {} : { attributes: entry.attributes }),
            };
            return { status: 201, created: true, entryId: 1 };
        },
        async delete(pathname) {
            deleted = pathname;
            if (overrides.delete !== undefined) return overrides.delete(pathname);
            storedEntry = null;
            return { status: 200 };
        },
    };
    const channels: ChannelCaps = {
        async append() { return { status: 200 }; },
        async replace() { return { status: 200 }; },
        async setState() { return { status: 200 }; },
    };
    const notify: NotifyCaps = { streamEvent() {} };
    const projection = overrides.projection ?? projectionCaps();
    let current: StreamSubscription | null = null;
    const notifyChunk: StreamSubscription["notifyChunk"] = async (channel, chunk, mimetype) => {
        chunks.push({ channel, chunk, mimetype });
    };
    const close: StreamSubscription["close"] = async (result, summary, channelStates) => {
        closed = { result, summary, channelStates };
        settled.resolve(closed);
    };
    const subscriptions: SubscriptionCaps = {
        async open(pathname, handle) {
            opened = { pathname, handle };
            seq.push("open");
            current = Object.assign(localAbort.signal, { notifyChunk, close });
            return current;
        },
        async notifyChunk(channel, chunk, mimetype) {
            if (current === null) throw new Error("no open subscription");
            await current.notifyChunk(channel, chunk, mimetype);
        },
        async close(result, summary, channelStates) {
            if (current === null) throw new Error("no open subscription");
            await current.close(result, summary, channelStates);
        },
    };
    const ctx: SchemeCtx = {
        workspaceId: 1, workerId: 1, loopId: 1, turnId: 1, writer: "model", signal: overrides.signal,
        entries, channels, notify, projection,
        interactions: { request: async () => ({ status: "cancelled" }) },
        subscriptions,
    };
    return {
        ctx,
        inspect: () => ({ chunks, opened, closed, deleted, wrote, storedEntry, observedStorageRead, observedRead, seq }),
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
    op: "READ", delimiter: "READ", annotation: null, signal: null, target, lineMarker, body: null,
    position: { line: 0, column: 0 },
});
const sendStmt = (signal: number, target: UrlPath | null, body?: string): SendStatement => ({
    op: "SEND", delimiter: "SEND", annotation: null, signal, target, lineMarker: null,
    body: body === undefined ? null : { raw: body, json: null },
    position: { line: 0, column: 0 },
});
const editStmt = (target: UrlPath | null, body: string | null, lineMarker: ResolvedEditStatement["lineMarker"] = null): ResolvedEditStatement => ({
    op: "EDIT", delimiter: "EDIT", annotation: null, signal: null, target, lineMarker, body,
    position: { line: 0, column: 0 },
});
const killStmt = (target: UrlPath | null, body: string | null = null): KillStatement => ({
    op: "KILL", delimiter: "KILL", annotation: null, signal: null, target, lineMarker: null, body,
    position: { line: 0, column: 0 },
});
const findStmt = (target: UrlPath | null, body: FindStatement["body"] = null): FindStatement => ({
    op: "FIND", delimiter: "FIND", annotation: null, signal: null, target, lineMarker: null, body,
    position: { line: 0, column: 0 },
});
const prepareExactFind = (http: Http, statement: FindStatement, ctx: SchemeCtx) => {
    const target = statement.target;
    if (target === null || target.kind !== "url") {
        throw new TypeError("prepareExactFind requires one exact URL target");
    }
    return http.prepareRepresentation({
        target: { ...target, fragment: null },
        pathname: NetworkAddress.from(target).pathname,
    }, ctx);
};

// Producer-focused unit tests invoke the operation-neutral hook directly.
// Universal READ selection and projection are covered in plurnk-core.
const prepareRepresentation = (http: Http, statement: ReadStatement, ctx: SchemeCtx) => {
    const target = statement.target;
    if (target === null || target.kind !== "url") {
        return http.prepareRepresentation({
            target: target ?? { kind: "local", raw: "" },
            pathname: "",
        }, ctx);
    }
    return http.prepareRepresentation({
        target: { ...target, fragment: null },
        pathname: NetworkAddress.from(target).pathname,
    }, ctx);
};

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
    // {§http-llms-txt} — the companion probe is routed to a quiet 404 by
    // default so ordinary fixtures model the pre-companion world; tests that
    // exercise the companion pass `true` and answer /llms.txt themselves.
    answerLlmsText = false,
) => {
    const original = globalThis.fetch;
    const publicUrl = allowAllTargets ? mock.method(Guard, "isPublicUrl", async () => true) : null;
    const wrapped = answerLlmsText
        ? impl
        : async (input: string | URL | Request, init?: RequestInit) =>
            String(input).endsWith("/llms.txt")
                ? new Response(null, { status: 404 })
                : (impl as typeof fetch)(input, init);
    globalThis.fetch = wrapped as typeof fetch;
    try { await fn(); } finally {
        globalThis.fetch = original;
        publicUrl?.mock.restore();
    }
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── manifest ──────────────────────────────────────────────────────────────
test("manifest: name http, default channel body, requiresWeb, network-volatile", () => {
    assert.equal(Http.manifest.name, "http");
    assert.equal(Http.manifest.glyph, "🌐");
    assert.equal(Http.manifest.defaultChannel, "body");
    assert.equal(Http.manifest.flags?.requiresWeb, true);
    assert.equal(Http.manifest.volatile, true);
    assert.deepEqual(Object.keys(Http.manifest.channels).sort(), ["body", "header", "html"]);
    // Self-doc for the model's packet listing (deep docs ride worker://plurnk/docs/http.md).
    const examples = (Http.manifest.example ?? "").split("\n\n");
    assert.equal(examples.length, 3, "HTTP teaches one retrieval and both mutation choices");
    assert.match(examples[0] ?? "", /^## READ0 \(https:\/\/[^)]+\)$/u);
    assert.match(examples[1] ?? "", /^## EDIT0 \(https:\/\/[^)]+\{Content-Type: application\/json\}\)\n\{.+\}$/u);
    assert.match(examples[2] ?? "", /^## SEND0 \[200\] \(https:\/\/[^)]+\{Content-Type: application\/json\}\)\n\{.+\}$/u);
});

test("manifest: documentation is loaded verbatim from docs/http.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const fromFile = await readFile(new URL("../docs/http.md", import.meta.url), "utf-8");
    assert.equal(Http.manifest.documentation, fromFile);
    assert.match(Http.manifest.documentation ?? "", /^# http\(s\):\/\//);
});

test("ready validates the fetch ceiling without making a provider request", async () => {
    const originalTimeout = process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT;
    let calls = 0;
    try {
        await withFetch((async () => {
            calls += 1;
            throw new Error("readiness must not call the materializer");
        }) as typeof fetch, async () => {
            process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT = "0";
            await assert.rejects(new Http().ready(), /must be a positive integer/);
        });
        assert.equal(calls, 0);
    } finally {
        if (originalTimeout === undefined) delete process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT;
        else process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT = originalTimeout;
    }
});

test("exact FIND preparation materializes an exact URL through the checked readable path", async () => {
    const { ctx, inspect } = makeCtx();
    const http = new Http();
    const target = urlTarget("https://example.com/dist/index.json", "/dist/index.json");
    await withFetch(
        mockFetch(200, "OK", ['{"version":"24.18.0"}'], { "content-type": "application/json" }),
        async () => {
            const prepared = await prepareExactFind(http, findStmt(target), ctx);
            assert.equal(prepared.status, 200);
        },
    );
    assert.equal(inspect().wrote?.pathname, "/example.com/dist/index.json");
    assert.equal(inspect().wrote?.entry.channels.body?.content, '{"version":"24.18.0"}');
    assert.equal(inspect().wrote?.entry.channels.body?.mimetype, "application/json");
});

test("exact FIND preparation preserves a provider-only page's unavailable HTML channel", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => ({
            outcome: "success",
            body: "provider body",
            identity: "stub-extract:v1",
            evidence: [{ name: "x-plurnk-stub-request-id", value: "req-provider-only" }],
        }),
    });
    const { ctx, inspect } = makeCtx();
    const target = urlTarget("https://example.com/provider-only", "/provider-only");
    await withFetch((async () => {
        throw new Error("origin unavailable");
    }) as typeof fetch, async () => {
        const prepared = await prepareExactFind(new Http(), findStmt(target), ctx);
        assert.equal(prepared.status, 200);
    });

    assert.equal(inspect().wrote?.entry.channels.body?.content, "provider body");
    const html = inspect().wrote?.entry.channels.html;
    assert.equal(html?.content, "");
    assert.equal(html?.mimetype, "text/html");
    assert.equal(html?.state, "errored");
    assert.equal(html?.producerResult?.status, 502);
    assert.equal(
        html?.producerResult?.problem?.type,
        "https://problems.plurnk.dev/scheme/http/html-unavailable",
    );
});

test("exact FIND preparation persists a readable binary projection with source and projection evidence", async () => {
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
        const result = await prepareExactFind(new Http(),
            findStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
            ctx,
        );
        assert.equal(result.status, 200);
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

test("exact FIND preparation reports the binary input ceiling as a typed 413 without persisting bytes", async (t) => {
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
    let result: Awaited<ReturnType<typeof prepareExactFind>> | undefined;
    await withFetch(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "application/pdf" },
    }), async () => {
        result = await prepareExactFind(new Http(),
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

test("exact FIND preparation treats XHTML and a present empty projection as successful materialization", async () => {
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
    await withFetch(
        mockFetch(200, "OK", ["<html><body></body></html>"], { "content-type": "application/xhtml+xml" }),
        async () => {
            const result = await prepareExactFind(new Http(),
                findStmt(urlTarget("https://example.com/empty.xhtml", "/empty.xhtml")),
                ctx,
            );
            assert.equal(result.status, 200);
        },
    );
    assert.deepEqual(inspect().wrote?.entry.channels.body, { content: "", mimetype: "text/markdown" });
    assert.deepEqual(inspect().wrote?.entry.channels.html, {
        content: "<html><body></body></html>",
        mimetype: "application/xhtml+xml",
    });
});

test("exact FIND preparation persists an absent final HTML projection as the body channel's exact 422", async () => {
    const projection = projectionCaps({ async readable() { return null; } });
    const { ctx, inspect } = makeCtx(null, { projection });
    await withFetch(
        mockFetch(200, "OK", ["<html><body><div></div></body></html>"], { "content-type": "text/html" }),
        async () => {
            const result = await prepareExactFind(new Http(),
                findStmt(urlTarget("https://example.com/empty", "/empty")),
                ctx,
            );
            assert.equal(result.status, 200);
        },
    );
    const body = inspect().wrote?.entry.channels.body;
    assert.equal(body?.content, "");
    assert.equal(body?.state, "errored");
    assert.equal(body?.producerResult?.status, 422);
    assert.equal(
        body?.producerResult?.problem?.type,
        "https://problems.plurnk.dev/scheme/http/no-readable-projection",
    );
});

test("exact FIND preparation reports a projection exception as 500 and logs its cause", async (t) => {
    const cause = new Error("reader implementation failed");
    const projection = projectionCaps({ async readable() { throw cause; } });
    const { ctx, inspect } = makeCtx(null, { projection });
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    await withFetch(
        mockFetch(200, "OK", ["<html><body>page</body></html>"], { "content-type": "text/html" }),
        async () => {
            const result = await prepareExactFind(new Http(),
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

test("exact FIND preparation reports caller cancellation during origin acquisition as 499", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const { ctx, inspect } = makeCtx(null, { signal: controller.signal });
    let result: Awaited<ReturnType<typeof prepareExactFind>> | undefined;
    await withFetch(async () => {
        controller.abort(reason);
        throw reason;
    }, async () => {
        result = await prepareExactFind(new Http(),
            findStmt(urlTarget("https://example.com/cancelled-probe", "/cancelled-probe")),
            ctx,
        );
    });
    assert.ok(result);
    assert.equal(result.status, 499);
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/http/cancelled");
    assert.equal(result.problem?.retryable, false);
    assert.equal(inspect().wrote, null);
});

test("exact FIND preparation does not relabel an unrelated failure after a later caller abort", async (t) => {
    const controller = new AbortController();
    const failure = new Error("unrelated acquisition defect");
    const { ctx } = makeCtx(null, { signal: controller.signal });
    t.mock.method(WebFetcher.prototype, "fetch", async () => {
        controller.abort(new Error("later cancellation"));
        throw failure;
    });
    await assert.rejects(
        prepareExactFind(new Http(),
            findStmt(urlTarget("https://example.com/failed-probe", "/failed-probe")),
            ctx,
        ),
        (error: unknown) => error === failure,
    );
});

test("exact FIND preparation rewrites acquisition but stores the addressed GitHub identity", async () => {
    const { ctx, inspect } = makeCtx();
    let seenUrl = "";
    const blob = "https://github.com/nodejs/node/blob/main/src/node_version.h";
    await withFetch(async (url) => {
        seenUrl = String(url);
        return new Response("// source", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
        const prepared = await prepareExactFind(new Http(),
            findStmt(urlTarget(blob, "/nodejs/node/blob/main/src/node_version.h")),
            ctx,
        );
        assert.equal(prepared.status, 200);
    });
    assert.equal(seenUrl, "https://raw.githubusercontent.com/nodejs/node/main/src/node_version.h");
    assert.equal(inspect().wrote?.pathname, "/github.com/nodejs/node/blob/main/src/node_version.h");
});

test("exact FIND preparation preserves an exact storage-read failure without fetching", async () => {
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
        const result = await prepareExactFind(new Http(),
            findStmt(urlTarget("https://example.com/x", "/x")),
            ctx,
        );
        assert.deepEqual(result, { ...failure, shape: "passthrough" });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
});

test("exact FIND preparation preserves an exact storage-write failure", async () => {
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
            const result = await prepareExactFind(new Http(),
                findStmt(urlTarget("https://example.com/x", "/x")),
                ctx,
            );
            assert.deepEqual(result, { ...failure, shape: "passthrough" });
        },
    );
});

test("exact FIND preparation preserves an unmarked authored entry without network acquisition", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("authored representation", "text/plain", "", undefined, "static"));
    let fetched = false;
    await withFetch(async () => {
        fetched = true;
        return new Response("wrong");
    }, async () => {
        const result = await prepareExactFind(new Http(),
            findStmt(urlTarget("https://example.com/authored", "/authored")),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
});

// ── acquisition lifecycle {§http-lifecycle} ───────────────────────────────
test("finite GET materializes complete channels without opening a subscription", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["x"], { "content-type": "text/plain" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/robots.txt", "/robots.txt")), ctx);
    });
    const { wrote, seq } = inspect();
    assert.deepEqual(seq, ["write"]);
    assert.equal(wrote?.pathname, "/example.com/robots.txt");
    assert.deepEqual(Object.keys(wrote!.entry.channels).sort(), ["body", "header", "html"]);
    assert.deepEqual(wrote!.entry.channels.body, { content: "x", mimetype: "text/plain" });
    assert.match(wrote!.entry.channels.header?.content ?? "", /^HTTP 200 OK/m);
    assert.equal(wrote!.entry.channels.html?.state, "errored");
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
test("finite GET stores its complete body and returns ready", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["hello ", "world"], { "content-type": "text/plain" }), async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 200);
    });
    const { opened, closed, wrote } = inspect();
    assert.equal(opened, null);
    assert.equal(closed, null);
    assert.deepEqual(wrote?.entry.channels.body, { content: "hello world", mimetype: "text/plain" });
});

test("finite HTTP errors preserve their body and exact default-channel outcome", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(404, "Not Found", ["missing"], { "content-type": "text/plain" }), async () => {
        const result = await prepareRepresentation(
            new Http(),
            readStmt(urlTarget("https://example.com/missing", "/missing")),
            ctx,
        );
        assert.equal(result.status, 200, "the complete representation is ready for core projection");
    });
    const body = inspect().wrote?.entry.channels.body;
    assert.equal(body?.content, "missing");
    assert.equal(body?.state, "errored");
    assert.equal(body?.producerResult?.status, 404);
    assert.equal(
        body?.producerResult?.problem?.type,
        "https://problems.plurnk.dev/scheme/http/http-response-status",
    );
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
        const result = await prepareRepresentation(new Http(), readStmt(target), ctx);
        assert.equal(result.status, 200);
    });
    assert.equal(seenUrl, "https://example.com:8443/x?b=2&a=1&a=3");
    assert.equal(new Headers(seenHeaders).get("Authorization"), "Bearer example");
    assert.equal(inspect().wrote?.pathname, "/example.com:8443/x?b=2&a=1&a=3");
    assert.equal(inspect().opened, null);
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
        const result = await prepareRepresentation(new Http(), readStmt(target), ctx);
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
            (http: Http, ctx: SchemeCtx) => prepareRepresentation(http, readStmt(target), ctx),
            (http: Http, ctx: SchemeCtx) => http.send(sendStmt(200, target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => http.edit(editStmt(target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => http.kill(killStmt(target), ctx),
        ];
        for (const [index, operation] of operations.entries()) {
            const { ctx, inspect } = makeCtx();
            assert.equal((await operation(new Http(), ctx)).status, index === 0 ? 200 : 102);
            assert.equal(inspect().closed?.result.status, index === 0 ? undefined : 200);
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

test("preparation is line-scope-blind and leaves selection to core", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("complete page", "text/markdown", ""));
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        const statement = readStmt(urlTarget("https://example.com/x", "/x"), { marks: [2, 4] });
        const result = await prepareRepresentation(new Http(), statement, ctx);
        assert.equal(result.status, 200);
        assert.equal(inspect().observedRead, null, "the producer never receives or applies text scope");
    });
    assert.equal(fetched, false, "a range observation never re-enters the network path");
    assert.equal(inspect().wrote, null, "the materialized entry is not replaced with a stream seed");
    assert.equal(inspect().opened, null, "no subscription is opened for a stored range");
});

test("preparation is channel-blind even when an auxiliary channel was authored", async () => {
    const statement = readStmt(
        urlTarget("https://example.com/x#header", "/x", undefined, "header"),
        { marks: [2] },
    );
    const { ctx, inspect } = makeCtx(
        priorEntry("", "text/plain", "HTTP 204 No Content\ncontent-type: text/plain"),
    );
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        assert.equal((await prepareRepresentation(new Http(), statement, ctx)).status, 200);
    });
    assert.equal(inspect().observedRead, null);
    assert.equal(inspect().observedStorageRead, "/example.com/x");
    assert.equal(fetched, false, "a scoped auxiliary-channel observation never enters the network path");
});

test("preparation cannot observe a core selection failure", async () => {
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
    const result = await prepareRepresentation(new Http(),
        readStmt(urlTarget("https://example.com/x", "/x"), { marks: [30, 100] }),
        ctx,
    );
    assert.equal(result.status, 200);
});

test("channel selection cannot suppress representation acquisition", async () => {
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
    await withFetch(async () => {
        fetched = true;
        return new Response("complete", { headers: { "content-type": "text/plain" } });
    }, async () => {
        const result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/x", "/x"), { marks: [2, 4] }),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    assert.equal(fetched, true);
    assert.equal(inspect().observedStorageRead, "/example.com/x");
    assert.equal(inspect().opened, null);
});

test("an unknown channel is withheld from the producer and rejected later by core", async () => {
    const { ctx, inspect } = makeCtx();
    let fetched = false;
    await withFetch(async () => {
        fetched = true;
        return new Response("body", { headers: { "content-type": "text/plain" } });
    }, async () => {
        const result = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/x", "/x", undefined, "raw")), ctx);
        assert.equal(result.status, 200);
    });
    assert.equal(fetched, true);
    assert.equal(inspect().opened, null);
});

test("READ: non-HTML body is labelled with its real content-type", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ['{"a":1}'], { "content-type": "Application/JSON; charset=utf-8" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/d.json", "/d.json")), ctx);
    });
    assert.equal(inspect().wrote?.entry.channels.body?.mimetype, "application/json");
});

test("READ: textual bytes follow Fetch UTF-8 decoding regardless of charset metadata", async () => {
    const { ctx, inspect } = makeCtx();
    const windows1252 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    await withFetch(mockFetch(200, "OK", [windows1252], {
        "content-type": "text/plain; charset=windows-1252",
    }), async () => {
        assert.equal(
            (await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/legacy.txt", "/legacy.txt")), ctx)).status,
            200,
        );
    });

    assert.equal(
        inspect().wrote?.entry.channels.body?.content,
        "caf�",
    );
    assert.match(
        inspect().wrote?.entry.channels.header?.content ?? "",
        /^content-type: text\/plain; charset=windows-1252$/m,
    );
});

test("READ: an unparseable Content-Type is an unknown binary representation", async () => {
    const { ctx, inspect } = makeCtx();
    let result: Awaited<ReturnType<typeof prepareRepresentation>> | undefined;
    await withFetch(mockFetch(200, "OK", ["not trustworthy"], {
        "content-type": "text/plain garbage",
    }), async () => {
        result = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/bad", "/bad")), ctx);
    });

    assert.equal(result?.status, 415);
    assert.equal(result?.problem?.mimetype, "application/octet-stream");
    assert.equal(inspect().wrote, null);
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
    let result: Awaited<ReturnType<typeof prepareRepresentation>> | undefined;
    await withFetch(mockFetch(200, "OK", [Uint8Array.of(37, 80, 68, 70)], {
        "content-type": "application/pdf",
    }), async () => {
        result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
            ctx,
        );
    });

    assert.equal(result?.status, 200);
    assert.deepEqual(inspect().wrote?.entry.channels.body, {
        content: "# projected paper",
        mimetype: "text/markdown",
    });
    const header = inspect().wrote?.entry.channels.header?.content ?? "";
    assert.match(header, /^content-type: application\/pdf$/m);
    assert.match(header, /^x-plurnk-projection-id: pdf-reader-v3$/m);
    assert.equal(inspect().closed, null);
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
    let result: Awaited<ReturnType<typeof prepareRepresentation>> | undefined;
    await withFetch(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "application/pdf" },
    }), async () => {
        result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/large.pdf", "/large.pdf")),
            ctx,
        );
    });

    assert.equal(result?.status, 413);
    assert.equal(result?.problem?.type, "https://problems.plurnk.dev/scheme/http/projection-input-limit");
    assert.equal(result?.problem?.maximumBytes, 3);
    assert.equal(result?.problem?.observedBytes, 4);
    assert.equal(inspect().wrote, null);
    assert.equal(cancelled, true);
    assert.equal(inspect().closed, null);
    assert.equal(diagnostics.length, 0);
});

test("READ: an undeclared body is an application/octet-stream marker, not guessed text", async () => {
    const { ctx, inspect } = makeCtx();
    let result: Awaited<ReturnType<typeof prepareRepresentation>> | undefined;
    await withFetch(async () => new Response(new Uint8Array([0x68, 0x69]), {
        status: 200,
        statusText: "OK",
    }), async () => {
        result = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/unknown", "/unknown")), ctx);
    });

    assert.equal(result?.status, 415);
    assert.equal(result?.problem?.mimetype, "application/octet-stream");
    assert.equal(inspect().wrote, null);
});

// ── server-sent events {§sse} ─────────────────────────────────────────────
const sseBody = (chunks: Array<{ channel: string; chunk: string }>) =>
    chunks.filter((c) => c.channel === "body").map((c) => c.chunk);

test("READ SSE: each event's data becomes one body chunk, framing stripped", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: hello\n\n", "data: world\n\n"], { "content-type": "text/event-stream" }), async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
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
        const read = prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
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
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    assert.deepEqual(sseBody(inspect().chunks), ["a\nb\n"]);
});

test("READ SSE: comment and metadata-only frames drop; only data dispatches", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", [": keep-alive\n\n", "event: greet\nid: 7\ndata: payload\n\n"], { "content-type": "text/event-stream" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    const { chunks, closed } = inspect();
    assert.deepEqual(sseBody(chunks), ["payload\n"]);
    assert.equal(closed?.summary, "SSE stream; 1 events");
});

test("READ SSE: an event split across network chunks reassembles", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: par", "tial\n", "\n"], { "content-type": "text/event-stream" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    assert.deepEqual(sseBody(inspect().chunks), ["partial\n"]);
});

test("READ SSE: CRLF-framed events parse (\\r normalized)", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: crlf\r", "\n\r", "\n"], { "content-type": "text/event-stream" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
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
            const result = await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
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
        const initial = await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        assert.equal(initial.status, 102);
        await forceCancel();
        controller.error(new DOMException("aborted", "AbortError"));
        const terminal = await awaitClosed();
        assert.equal(terminal.result.status, 499);
        assert.equal(terminal.result.problem?.type, "https://problems.plurnk.dev/scheme/http/cancelled");
    });
});

test("HTML preparation archives server HTML while body carries the model-facing projection", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["<html><body><h1>Hello</h1></body></html>"], { "content-type": "text/html; charset=utf-8" }), async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/spa", "/spa")), ctx);
        assert.equal(r.status, 200);
    });
    assert.deepEqual(inspect().wrote?.entry.channels.body, {
        content: "Hello",
        mimetype: "text/markdown",
    });
    assert.deepEqual(inspect().wrote?.entry.channels.html, {
        content: "<html><body><h1>Hello</h1></body></html>",
        mimetype: "text/html",
    });
});

test("READ: a present empty HTML projection succeeds and retains its HTML evidence", async () => {
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
    await withFetch(
        mockFetch(200, "OK", [html], { "content-type": "text/html" }),
        async () => {
            const result = await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/empty", "/empty")),
                ctx,
            );
            assert.equal(result.status, 200);
        },
    );
    assert.deepEqual(inspect().wrote?.entry.channels.body, {
        content: "",
        mimetype: "text/markdown",
    });
    assert.equal(inspect().wrote?.entry.channels.html?.content, html);
    assert.equal(inspect().closed, null);
});

test("READ: public HTML uses the materializer Markdown and retains origin, request, and credit evidence ({§http-materializer-plugins})", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => ({
            outcome: "success",
            body: "# Stub body",
            identity: "stub-extract:v1",
            evidence: [
                { name: "x-plurnk-stub-request-id", value: "req-direct" },
                { name: "x-plurnk-stub-credits", value: "0.2" },
            ],
        }),
    });
    const projection = projectionCaps({
        async readable() {
            throw new Error("the local floor must not run after successful materialization");
        },
    });
    const { ctx, inspect } = makeCtx(null, { projection });
    const html = "<html><body><h1>Origin</h1></body></html>";
    await withFetch((async () =>
        new Response(html, { status: 200, statusText: "OK", headers: { "content-type": "application/xhtml+xml" } })) as typeof fetch, async () => {
        const result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/stub", "/stub")),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    assert.deepEqual(inspect().wrote?.entry.channels.body, {
        content: "# Stub body",
        mimetype: "text/markdown",
    });
    assert.deepEqual(inspect().wrote?.entry.channels.html, {
        content: html,
        mimetype: "application/xhtml+xml",
    });
    const header = inspect().wrote?.entry.channels.header?.content ?? "";
    assert.match(header, /^HTTP 200 OK/m);
    assert.match(header, /^x-plurnk-materializer-id: stub-extract:v1$/m);
    assert.match(header, /^x-plurnk-stub-request-id: req-direct$/m);
    assert.match(header, /^x-plurnk-stub-credits: 0\.2$/m);
});

test("READ: negotiated origin Markdown is authoritative and acquires auxiliary server HTML without the materializer", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { ctx, inspect } = makeCtx();
    const accepts: string[] = [];
    await withFetch((async (input, init) => {
        const accept = new Headers(init?.headers).get("accept") ?? "";
        accepts.push(accept);
        return accept === "text/html"
            ? new Response("<html><body>Origin source</body></html>", {
                status: 200,
                headers: { "content-type": "text/html" },
            })
            : new Response("# Origin Markdown", {
                status: 200,
                headers: { "content-type": "text/markdown", vary: "Accept" },
            });
    }) as typeof fetch, async () => {
        const result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/markdown", "/markdown")),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    assert.match(accepts[0] ?? "", /^text\/markdown/);
    assert.equal(accepts[1], "text/html");
    assert.equal(inspect().wrote?.entry.channels.body?.content, "# Origin Markdown");
    assert.equal(inspect().wrote?.entry.channels.html?.content, "<html><body>Origin source</body></html>");
    const header = inspect().wrote?.entry.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-materializer-id: origin-markdown:v1$/m);
    assert.match(header, /^x-plurnk-html-status: 200$/m);
    assert.equal(inspect().closed, null);
});

for (const selected of ["body", "html", "header"] as const) {
    test(`preparation with authored #${selected} persists independent materializer channel outcomes`, async () => {
        process.env[MATERIALIZER_ENV] = "stub";
        const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
        __stub.set({
            eligible: () => "stub-extract:v1",
            extract: async () => ({
                outcome: "hard",
                identity: "stub-extract:v1",
                evidence: [],
                problem: { status: 502, code: "stub-authentication-failed", detail: "The stub rejected the configured credentials.", retryable: false },
            }),
        });
        const projection = projectionCaps({
            async readable() { throw new Error("hard provider failure must not use the local floor"); },
        });
        const { ctx, inspect } = makeCtx(null, { projection });
        await withFetch((async () => new Response("<html><body>Durable source</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
        })) as typeof fetch, async () => {
            const result = await prepareRepresentation(new Http(),
                readStmt(urlTarget(
                    "https://example.com/hard-provider",
                    "/hard-provider",
                    undefined,
                    selected === "body" ? null : selected,
                )),
                ctx,
            );
            assert.equal(result.status, 200);
        });
        assert.equal(inspect().wrote?.entry.channels.body?.state, "errored");
        assert.equal(inspect().wrote?.entry.channels.body?.producerResult?.status, 502);
        assert.equal(inspect().wrote?.entry.channels.html?.content, "<html><body>Durable source</body></html>");
        assert.equal(inspect().closed, null);
    });
}

test("READ: recoverable materializer outcome uses the local floor with explicit terminal 203", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => ({
            outcome: "recoverable",
            reason: "not extractable",
            identity: "stub-extract:v1",
            evidence: [{ name: "x-plurnk-stub-request-id", value: "req-recover" }],
        }),
    });
    const projection = projectionCaps({
        async readable(_content, mimetype) {
            return {
                content: "local floor",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "floor-v1",
            };
        },
    });
    const { ctx, inspect } = makeCtx(null, { projection });
    await withFetch((async () => new Response("<html><body>Origin</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
    })) as typeof fetch, async () => {
        const result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/recover", "/recover")),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    assert.equal(inspect().wrote?.entry.channels.body?.content, "local floor");
    assert.equal(inspect().wrote?.entry.channels.body?.producerResult?.status, 203);
    const header = inspect().wrote?.entry.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-stub-request-id: req-recover$/m);
});

for (const selected of ["body", "html"] as const) {
    test(`READ #${selected}: the materializer body may survive admitted origin transport failure`, async () => {
        process.env[MATERIALIZER_ENV] = "stub";
        const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
        __stub.set({
            eligible: () => "stub-extract:v1",
            extract: async () => ({
                outcome: "success",
                body: "provider-only body",
                identity: "stub-extract:v1",
                evidence: [],
            }),
        });
        const { ctx, inspect } = makeCtx();
        await withFetch((async () => {
            throw new Error("origin reset");
        }) as typeof fetch, async () => {
            const result = await prepareRepresentation(new Http(),
                readStmt(urlTarget(
                    "https://example.com/provider-only",
                    "/provider-only",
                    undefined,
                    selected === "body" ? null : "html",
                )),
                ctx,
            );
            assert.equal(result.status, 200);
        });
        assert.equal(inspect().wrote?.entry.channels.body?.content, "provider-only body");
        assert.equal(inspect().wrote?.entry.channels.html?.state, "errored");
        assert.equal(inspect().wrote?.entry.channels.html?.producerResult?.status, 502);
        assert.equal(inspect().closed, null);
    });
}

test("READ: an absent HTML projection returns 422 and retains its HTML evidence", async () => {
    const projection = projectionCaps({ async readable() { return null; } });
    const { ctx, inspect } = makeCtx(null, { projection });
    const html = "<html><body><div></div></body></html>";
    let result: Awaited<ReturnType<typeof prepareRepresentation>> | undefined;
    await withFetch(
        mockFetch(200, "OK", [html], { "content-type": "text/html" }),
        async () => {
            result = await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/empty", "/empty")),
                ctx,
            );
        },
    );
    assert.equal(result?.status, 200);
    assert.equal(inspect().wrote?.entry.channels.body?.producerResult?.status, 422);
    assert.equal(inspect().wrote?.entry.channels.html?.content, html);
    assert.match(inspect().wrote?.entry.channels.header?.content ?? "", /^HTTP 200 OK/m);
});

test("READ: a projection exception returns 500, retains evidence, and logs its cause", async (t) => {
    const cause = new Error("reader implementation failed");
    const projection = projectionCaps({ async readable() { throw cause; } });
    const { ctx, inspect } = makeCtx(null, { projection });
    const html = "<html><body>page</body></html>";
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    let result: Awaited<ReturnType<typeof prepareRepresentation>> | undefined;
    await withFetch(
        mockFetch(200, "OK", [html], { "content-type": "text/html" }),
        async () => {
            result = await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/projection", "/projection")),
                ctx,
            );
        },
    );
    assert.equal(result?.status, 500);
    assert.equal(result?.problem?.type, "https://problems.plurnk.dev/scheme/http/projection-failed");
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().closed, null);
    assert.equal((diagnostics[0]?.[1] as { error?: Error })?.error?.cause, cause);
});

test("SEND[200]: an HTML response streams body text as text/html", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["<html>body</html>"], { "content-type": "text/html" }), async () => {
        await new Http().send(sendStmt(200, urlTarget("https://example.com/p", "/p"), "payload"), ctx);
    });
    const body = inspect().chunks.filter((c) => c.channel === "body").map((c) => c.chunk).join("");
    assert.equal(body, "<html>body</html>");
});

test("READ: non-url target → 400 with RFC 9457 Problem Details", async () => {
    const { ctx } = makeCtx();
    const r = await prepareRepresentation(new Http(), readStmt(null), ctx);
    assert.equal(r.status, 400);
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/http/bad-target");
});

test("READ: empty response body closes done without body chunks", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(204, "No Content", []), async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 200);
    });
    assert.equal(inspect().wrote?.entry.channels.body?.content, "");
    assert.equal(inspect().closed, null);
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
        const result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/x", "/x")),
            ctx,
        );
        assert.deepEqual(result, { ...failure, shape: "passthrough" });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().opened, null);
});

test("GET preserves an exact materialization-write failure", async () => {
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
        const result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/x", "/x")),
            ctx,
        );
        assert.deepEqual(result, { ...failure, shape: "passthrough" });
    });
    assert.equal(fetched, true);
    assert.equal(inspect().opened, null);
});

test("origin failure becomes durable body-channel producer evidence", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 200);
    });
    assert.equal(inspect().wrote?.entry.channels.body?.producerResult?.status, 502);
    assert.equal(
        inspect().wrote?.entry.channels.body?.producerResult?.problem?.type,
        "https://problems.plurnk.dev/scheme/http/fetch-failed",
    );
});

test("READ: network failure bounds caught diagnostics in the exact Problem", async () => {
    const prior = process.env.PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT;
    process.env.PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT = "4";
    try {
        const { ctx, inspect } = makeCtx();
        await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
            const result = await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/x", "/x")), ctx);
            assert.equal(result.status, 200);
            assert.equal(
                inspect().wrote?.entry.channels.body?.producerResult?.problem?.detail,
                "HTTP GET http://example.com/x failed: ECON...",
            );
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
        await prepareRepresentation(new Http(), readStmt(target), ctx);
    });
    // The default web identity rides first when the model supplied no UA block.
    assert.deepEqual(seenHeaders, [["User-Agent", (seenHeaders as [string, string][])[0][1]], ["Authorization", "Bearer T"], ["Accept", "application/json"]]);
    assert.match((seenHeaders as [string, string][])[0][1], /Mozilla.*Chrome/);
});

test("READ: headers reach direct fetch on an HTML GET (authed page requests authed)", async () => {
    const { ctx, inspect } = makeCtx();
    const target = urlTarget("https://app.x/dash", "/dash", [["Authorization", "Bearer T"]]);
    let seenAuth = "";
    const seenUrls: string[] = [];
    await withFetch((async (url, init) => {
        seenUrls.push(String(url));
        seenAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response("<html><body>authed</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch, async () => {
        await prepareRepresentation(new Http(), readStmt(target), ctx);
    });
    assert.equal(seenAuth, "Bearer T");
    assert.deepEqual(seenUrls, ["https://app.x/dash"], "explicit request metadata never authorizes the materializer");
    const header = inspect().storedEntry?.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-materializer-id: local-projection:v1:ineligible$/m);
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
    const r = await new Http().edit(editStmt(urlTarget("https://api.x/thing/42", "/thing/42"), "x", { marks: [1] }), ctx);
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
        await prepareRepresentation(new Http(), readStmt(urlTarget(blob, "/nodejs/node/blob/main/src/node_version.h")), ctx);
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
        await prepareRepresentation(new Http(), readStmt(urlTarget(blob, "/o/r/blob/feature/foo/src/x.js")), ctx);
    });
    assert.equal(seenUrl, "https://raw.githubusercontent.com/o/r/feature/foo/src/x.js");
});

test("non-GitHub URL is fetched verbatim (no rewrite)", async () => {
    const { ctx } = makeCtx();
    let seenUrl = "";
    const probe = async (url: string | URL | Request) => { seenUrl = String(url); return new Response("ok", { status: 200 }); };
    await withFetch(probe as typeof fetch, async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/x", "/x")), ctx);
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
});

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
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/item", "/item")), ctx);
    });
    assert.equal(conditional, false);
    assert.equal(inspect().storedEntry?.channels.body?.content, "get response");
});

test("exact FIND preparation reacquires an exact URL whose stored response came from a mutation", async () => {
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
        const result = await prepareExactFind(new Http(),
            findStmt(urlTarget("https://example.com/item", "/item")),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    assert.equal(fetched, true);
    assert.equal(inspect().wrote?.entry.channels.body?.content, "current representation");
});

test("exact FIND preparation reuses only a derived representation produced by the installed projection", async () => {
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
            const result = await prepareExactFind(new Http(),
                findStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
                ctx,
            );
            assert.equal(result.status, 200);
        });
        assert.equal(fetched, expectedFetch);
        assert.equal(inspect().wrote?.entry.channels.body?.content, expectedFetch ? "current projection" : undefined);
    }
});

test("stale materializer HTML-page materialization performs full reacquisition without origin validators", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => ({
            outcome: "success",
            body: "fresh page",
            identity: "stub-extract:v1",
            evidence: [{ name: "x-plurnk-stub-request-id", value: "req-fresh" }],
        }),
    });
    const { ctx, inspect } = makeCtx(priorEntry(
        "cached page",
        "text/markdown",
        `${stampedHeader(500_000, '\ncontent-type: text/html\netag: "v1"')}\n${MATERIALIZER_ID_HEADER}: stub-extract:v1\nx-plurnk-stub-request-id: req-cached`,
        "<html>cached page</html>",
    ));
    let conditional = false;
    const probe = async (input: string | URL | Request, init?: RequestInit) => {
        conditional = new Headers(init?.headers).has("if-none-match");
        return new Response("<html>fresh page</html>", {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/html", etag: '"v2"' },
        });
    };
    await withFetch(probe as typeof fetch, async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        assert.equal(r.status, 200);
    });
    assert.equal(conditional, false);
    assert.equal(inspect().storedEntry?.channels.body?.content, "fresh page");
    assert.equal(inspect().storedEntry?.channels.html?.content, "<html>fresh page</html>");
    const header = inspect().storedEntry?.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-materializer-id: stub-extract:v1$/m);
    assert.match(header, /^x-plurnk-stub-request-id: req-fresh$/m);
});

test("TTL: enabling a materializer invalidates a locally materialized HTML body and its validators", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => ({
            outcome: "success",
            body: "# Current stub body",
            identity: "stub-extract:v1",
            evidence: [],
        }),
    });
    const storedHeader = `${stampedHeader(
        1000,
        '\ncontent-type: text/html\netag: "local-v1"',
    )}\n${MATERIALIZER_ID_HEADER}: local-projection:v1\nx-plurnk-projection-id: test:text/html`;
    const { ctx, inspect } = makeCtx(priorEntry(
        "old local body",
        "text/markdown",
        storedHeader,
        "<html>old source</html>",
    ));
    let originFetched = false;
    let conditional = false;
    await withTtl("60000", async () => {
        await withFetch((async (input, init) => {
            originFetched = true;
            conditional = new Headers(init?.headers).has("if-none-match");
            return new Response("<html>current source</html>", {
                status: 200,
                headers: { "content-type": "text/html", etag: '"current"' },
            });
        }) as typeof fetch, async () => {
            await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/page", "/page")),
                ctx,
            );
        });
    });
    assert.equal(originFetched, true);
    assert.equal(conditional, false, "old validators cannot certify a different materializer route");
    assert.equal(inspect().storedEntry?.channels.body?.content, "# Current stub body");
});

for (const {
    name,
    storedValidator,
    responseHeaders,
    expectedConditional,
    valid,
} of [
    {
        name: "the same strong ETag identifies the stored response",
        storedValidator: 'etag: "v1"',
        responseHeaders: { etag: '"v1"' },
        expectedConditional: ["if-none-match", '"v1"'],
        valid: true,
    },
    {
        name: "a different strong ETag cannot certify the stored response",
        storedValidator: 'etag: "v1"',
        responseHeaders: { etag: '"v2"' },
        expectedConditional: ["if-none-match", '"v1"'],
        valid: false,
    },
    {
        name: "a weak response ETag can weakly identify a stored strong tag",
        storedValidator: 'etag: "v1"',
        responseHeaders: { etag: 'W/"v1"' },
        expectedConditional: ["if-none-match", '"v1"'],
        valid: true,
    },
    {
        name: "a strong response ETag weakly identifies a stored weak tag",
        storedValidator: 'etag: W/"v1"',
        responseHeaders: { etag: '"v1"' },
        expectedConditional: ["if-none-match", 'W/"v1"'],
        valid: true,
    },
    {
        name: "the same weak ETag identifies the stored response",
        storedValidator: 'etag: W/"v1"',
        responseHeaders: { etag: 'W/"v1"' },
        expectedConditional: ["if-none-match", 'W/"v1"'],
        valid: true,
    },
    {
        name: "the same Last-Modified value identifies the stored response",
        storedValidator: "last-modified: Tue, 15 Nov 1994 12:45:26 GMT",
        responseHeaders: { "last-modified": "Tue, 15 Nov 1994 12:45:26 GMT" },
        expectedConditional: ["if-modified-since", "Tue, 15 Nov 1994 12:45:26 GMT"],
        valid: true,
    },
    {
        name: "an equivalent obsolete Last-Modified date identifies the stored response",
        storedValidator: "last-modified: Tue, 15 Nov 1994 12:45:26 GMT",
        responseHeaders: { "last-modified": "Tue Nov 15 12:45:26 1994" },
        expectedConditional: ["if-modified-since", "Tue, 15 Nov 1994 12:45:26 GMT"],
        valid: true,
    },
    {
        name: "a different Last-Modified value cannot certify the stored response",
        storedValidator: "last-modified: Tue, 15 Nov 1994 12:45:26 GMT",
        responseHeaders: { "last-modified": "Wed, 16 Nov 1994 12:45:26 GMT" },
        expectedConditional: ["if-modified-since", "Tue, 15 Nov 1994 12:45:26 GMT"],
        valid: false,
    },
    {
        name: "matching malformed Last-Modified values cannot certify the stored response",
        storedValidator: "last-modified: 0",
        responseHeaders: { "last-modified": "0" },
        expectedConditional: null,
        valid: false,
    },
    {
        name: "matching malformed ETags cannot certify the stored response",
        storedValidator: "etag: not-an-entity-tag",
        responseHeaders: { etag: "not-an-entity-tag" },
        expectedConditional: null,
        valid: false,
    },
    {
        name: "a missing response validator cannot certify an ETag-nominated response",
        storedValidator: 'etag: "v1"',
        responseHeaders: {},
        expectedConditional: ["if-none-match", '"v1"'],
        valid: false,
    },
    {
        name: "a malformed response ETag cannot certify the stored response",
        storedValidator: 'etag: "v1"',
        responseHeaders: { etag: "not-an-entity-tag" },
        expectedConditional: ["if-none-match", '"v1"'],
        valid: false,
    },
    {
        name: "an unsolicited validator-less 304 cannot certify a stored response",
        storedValidator: null,
        responseHeaders: {},
        expectedConditional: null,
        valid: false,
    },
] as const) {
    test(`304 correspondence: ${name}`, async () => {
        const header = stampedHeader(
            500_000,
            storedValidator === null ? "" : `\n${storedValidator}`,
        );
        const { ctx, inspect } = makeCtx(priorEntry("cached", "text/plain", header));
        let requests = 0;
        await withTtl("0", async () => {
            await withFetch(async (_url, init) => {
                requests += 1;
                const sent = new Headers(init?.headers);
                if (requests === 1) {
                    if (expectedConditional === null) {
                        assert.equal(sent.has("if-none-match"), false);
                        assert.equal(sent.has("if-modified-since"), false);
                    } else {
                        assert.equal(sent.get(expectedConditional[0]), expectedConditional[1]);
                    }
                } else {
                    assert.equal(sent.has("if-none-match"), false, "the genuine-mismatch fallback re-issues without If-None-Match");
                    assert.equal(sent.has("if-modified-since"), false, "the genuine-mismatch fallback re-issues without If-Modified-Since");
                }
                return new Response(null, { status: 304, headers: responseHeaders });
            }, async () => {
                const result = await prepareRepresentation(new Http(),
                    readStmt(urlTarget("https://example.com/correspondence", "/correspondence")),
                    ctx,
                );
                assert.equal(result.status, valid ? 200 : 502);
                if (!valid) {
                    assert.equal(
                        result.problem?.type,
                        "https://problems.plurnk.dev/scheme/http/fetch-failed",
                    );
                    assert.match(result.problem?.detail ?? "", /304/);
                }
            });
        });
        assert.equal(requests, valid ? 1 : 2,
            "a genuinely mismatched 304 falls back to one unconditional GET ({§revalidation})");
        if (valid) {
            assert.equal(inspect().wrote?.entry.channels.body?.content, "cached");
        } else {
            assert.equal(inspect().wrote, null, "an invalid 304 cannot replace the stored representation");
        }
    });
}

test("READ revalidation: 200 (changed) re-fetches + streams normally despite a prior entry", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("old", "text/plain", stampedHeader(500_000, '\netag: "v1"')));
    await withFetch(mockFetch(200, "OK", ["fresh content"], { "content-type": "text/plain" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
    });
    assert.equal(inspect().storedEntry?.channels.body?.content, "fresh content");
    assert.equal(inspect().opened, null, "a finite replacement does not create a stream");
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
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/x", "/x")), ctx);
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
            await prepareRepresentation(new Http(), readStmt(urlTarget(
                "https://example.com/variant",
                "/variant",
                requestHeaders,
            )), ctx);
        });
        const header = inspect().storedEntry?.channels.header?.content ?? "";
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
            await prepareRepresentation(new Http(), readStmt(urlTarget(
                "https://example.com/account",
                "/account",
                [["Authorization", "Bearer private"]],
            )), ctx);
        });
    });
    assert.equal(fetched, true);
    assert.equal(conditional, false, "validators from the default representation do not cross request metadata");
    assert.equal(inspect().storedEntry?.channels.body?.content, "private representation");
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
            await prepareRepresentation(new Http(), readStmt(urlTarget(
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
                await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/variant", "/variant")), ctx);
            });
        });
        assert.equal(fetched, true);
        assert.equal(conditional, false);
        assert.equal(inspect().storedEntry?.channels.body?.content, "current representation");
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
            headers: { etag: '"v1"', vary: "Accept-Language" },
        }), async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/variant", "/variant")), ctx);
        });
    });
    const header = inspect().storedEntry?.channels.header?.content ?? "";
    assert.equal(
        [...header.matchAll(new RegExp(`^${CACHE_VARIANT_HEADER}:[ \\t]*(.+)$`, "gim"))].at(-1)?.[1].trim(),
        "bypass",
    );
});

test("exact FIND preparation reacquires request metadata through WebFetcher instead of reusing another variant", async () => {
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
        const result = await prepareExactFind(new Http(), findStmt(urlTarget(
            "https://example.com/account",
            "/account",
            [["Authorization", "Bearer private"]],
        )), ctx);
        assert.equal(result.status, 200);
    });
    assert.equal(authorization, "Bearer private");
    assert.equal(inspect().wrote?.entry.channels.body?.content, "private");
    assert.match(inspect().wrote?.entry.channels.header?.content ?? "", /x-plurnk-cache-variant: bypass$/m);
});

for (const state of ["active", "errored"] as const) {
    test(`exact FIND preparation cannot reuse a ${state} default representation`, async () => {
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
            assert.equal((await prepareExactFind(new Http(),
                findStmt(urlTarget(`https://example.com/${state}`, `/${state}`)),
                ctx,
            )).status, 200);
        });
        assert.equal(inspect().wrote?.entry.channels.body?.content, "complete");
    });
}

test("TTL: fresh stamp serves the stored copy with ZERO round-trips", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("cached page", "text/html", stampedHeader(1000)));
    let fetched = false;
    await withTtl("60000", async () => {
        await withFetch((async () => { fetched = true; throw new Error("must not fetch"); }) as unknown as typeof fetch, async () => {
            const r = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
            assert.equal(r.status, 200);
        });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().opened, null);
    assert.equal(inspect().storedEntry?.channels.body?.content, "cached page");
});

test("cache policy: no-store evidence supplies neither TTL content nor validators", async () => {
    const { ctx, inspect } = makeCtx(priorEntry(
        "historical response",
        "text/plain",
        stampedHeader(1000, '\ncache-control: no-store\netag: "private"'),
    ));
    let conditional = false;
    await withTtl("60000", async () => {
        await withFetch(async (_url, init) => {
            const headers = new Headers(init?.headers);
            conditional = headers.has("if-none-match") || headers.has("if-modified-since");
            return new Response("current response", {
                status: 200,
                headers: { "content-type": "text/plain" },
            });
        }, async () => {
            await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/no-store", "/no-store")),
                ctx,
            );
        });
    });
    assert.equal(conditional, false);
    assert.equal(inspect().storedEntry?.channels.body?.content, "current response");
});

for (const { name, ageMs, ttl, cacheHeaders, expectedFetch } of [
    {
        name: "max-age inside both origin and operator windows",
        ageMs: 1000,
        ttl: "60000",
        cacheHeaders: "cache-control: max-age=60",
        expectedFetch: false,
    },
    {
        name: "max-age beyond the origin window",
        ageMs: 2000,
        ttl: "60000",
        cacheHeaders: "cache-control: max-age=1",
        expectedFetch: true,
    },
    {
        name: "max-age inside origin but beyond the operator ceiling",
        ageMs: 2000,
        ttl: "1000",
        cacheHeaders: "cache-control: max-age=60",
        expectedFetch: true,
    },
    {
        name: "upstream Age beyond max-age",
        ageMs: 1000,
        ttl: "60000",
        cacheHeaders: "cache-control: max-age=60\nage: 120",
        expectedFetch: true,
    },
    {
        name: "qualified no-cache still requires validation",
        ageMs: 1000,
        ttl: "60000",
        cacheHeaders: 'cache-control: no-cache="set-cookie", max-age=60',
        expectedFetch: true,
    },
    {
        name: "a comma inside an extension argument is not a no-store directive",
        ageMs: 1000,
        ttl: "60000",
        cacheHeaders: 'cache-control: community="alpha,no-store", max-age=60',
        expectedFetch: false,
    },
    {
        name: "quoted max-age accepted from a recipient",
        ageMs: 1000,
        ttl: "60000",
        cacheHeaders: 'cache-control: MAX-AGE="60"',
        expectedFetch: false,
    },
    {
        name: "invalid explicit max-age fails stale",
        ageMs: 1000,
        ttl: "60000",
        cacheHeaders: "cache-control: max-age=tomorrow",
        expectedFetch: true,
    },
    {
        name: "ambiguous max-age fails stale",
        ageMs: 1000,
        ttl: "60000",
        cacheHeaders: "cache-control: max-age=60, max-age=120",
        expectedFetch: true,
    },
] as const) {
    test(`cache policy: ${name}`, async () => {
        const header = stampedHeader(ageMs, `\n${cacheHeaders}\netag: "policy"`);
        const { ctx } = makeCtx(priorEntry("cached", "text/plain", header));
        let fetched = false;
        let conditional = false;
        await withTtl(ttl, async () => {
            await withFetch(async (_url, init) => {
                fetched = true;
                const headers = new Headers(init?.headers);
                conditional = headers.has("if-none-match") || headers.has("if-modified-since");
                return new Response("fresh", {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                });
            }, async () => {
                await prepareRepresentation(new Http(),
                    readStmt(urlTarget("https://example.com/policy", "/policy")),
                    ctx,
                );
            });
        });
        assert.equal(fetched, expectedFetch);
        assert.equal(conditional, expectedFetch);
    });
}

test("cache policy: an expired Expires field bounds the operator heuristic", async () => {
    const generatedAt = new Date(Date.now() - 10_000);
    const expiredAt = new Date(generatedAt.getTime() + 5000);
    const { ctx } = makeCtx(priorEntry(
        "cached",
        "text/plain",
        stampedHeader(
            1000,
            `\ndate: ${generatedAt.toUTCString()}\nexpires: ${expiredAt.toUTCString()}\netag: "expires"`,
        ),
    ));
    let conditional = false;
    await withTtl("60000", async () => {
        await withFetch(async (_url, init) => {
            conditional = new Headers(init?.headers).has("if-none-match");
            return new Response("fresh", { headers: { "content-type": "text/plain" } });
        }, async () => {
            await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/expires", "/expires")),
                ctx,
            );
        });
    });
    assert.equal(conditional, true);
});

for (const { name, cacheHeaders, expectedFetch } of [
    { name: "fresh max-age", cacheHeaders: "cache-control: max-age=60", expectedFetch: false },
    { name: "no-cache", cacheHeaders: "cache-control: no-cache", expectedFetch: true },
    { name: "no-store", cacheHeaders: "cache-control: no-store", expectedFetch: true },
    { name: "expired max-age", cacheHeaders: "cache-control: max-age=0", expectedFetch: true },
] as const) {
    test(`exact FIND preparation cache policy: ${name}`, async () => {
        const { ctx } = makeCtx(priorEntry(
            "stored",
            "text/plain",
            stampedHeader(1000, `\n${cacheHeaders}\netag: "find"`),
            undefined,
            "static",
        ));
        let fetched = false;
        await withTtl("60000", async () => {
            await withFetch(async () => {
                fetched = true;
                return new Response("current", {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                });
            }, async () => {
                const result = await prepareExactFind(new Http(),
                    findStmt(urlTarget("https://example.com/find-policy", "/find-policy")),
                    ctx,
                );
                assert.equal(result.status, 200);
            });
        });
        assert.equal(fetched, expectedFetch);
    });
}

test("exact FIND preparation cache policy: an unset operator ceiling fails at configuration", async () => {
    const { ctx } = makeCtx(priorEntry(
        "stored",
        "text/plain",
        stampedHeader(1000, "\ncache-control: max-age=60"),
        undefined,
        "static",
    ));
    await withTtl(undefined, async () => {
        await assert.rejects(
            prepareExactFind(new Http(),
                findStmt(urlTarget("https://example.com/find-policy", "/find-policy")),
                ctx,
            ),
            /PLURNK_SCHEMES_HTTP_TTL_MS is unset/,
        );
    });
});

test("304 merges freshness metadata without relabeling a processed representation", async () => {
    const projection = projectionCaps({
        async identity(mimetype) {
            assert.equal(mimetype, "application/pdf");
            return "pdf-reader-v1";
        },
    });
    const storedHeader = `${stampedHeader(1000, [
        "",
        "content-type: application/pdf",
        "content-encoding: gzip",
        "content-range: bytes 0-9/10",
        "content-length: 10",
        "cache-control: no-cache",
        'etag: "pdf-v1"',
        "x-origin-version: 1",
    ].join("\n"))}\nx-plurnk-projection-id: pdf-reader-v1`;
    const { ctx, inspect } = makeCtx(
        priorEntry("projected PDF", "text/markdown", storedHeader),
        { projection },
    );
    let conditional = false;
    await withTtl("60000", async () => {
        await withFetch(async (_url, init) => {
            conditional = new Headers(init?.headers).get("if-none-match") === '"pdf-v1"';
            return new Response(null, {
                status: 304,
                statusText: "Not Modified",
                headers: {
                    "cache-control": "max-age=60",
                    "content-encoding": "br",
                    "content-length": "0",
                    "content-range": "bytes 0-0/0",
                    "content-type": "text/plain",
                    etag: '"pdf-v1"',
                    "x-origin-version": "2",
                },
            });
        }, async () => {
            await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
                ctx,
            );
        });
    });
    assert.equal(conditional, true, "no-cache forces successful origin validation");
    const served = inspect().storedEntry?.channels.header?.content ?? "";
    assert.match(served, /^cache-control: max-age=60$/m);
    assert.match(served, /^x-origin-version: 2$/m);
    assert.doesNotMatch(served, /^x-origin-version: 1$/m);
    assert.match(served, /^content-type: application\/pdf$/m);
    assert.match(served, /^content-encoding: gzip$/m);
    assert.match(served, /^content-range: bytes 0-9\/10$/m);
    assert.match(served, /^content-length: 10$/m);
    assert.match(served, /^x-plurnk-projection-id: pdf-reader-v1$/m);

    const { ctx: refreshedCtx } = makeCtx(
        priorEntry("projected PDF", "text/markdown", served),
        { projection },
    );
    let fetchedAgain = false;
    await withTtl("60000", async () => {
        await withFetch(async () => {
            fetchedAgain = true;
            return new Response("unexpected");
        }, async () => {
            await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
                refreshedCtx,
            );
        });
    });
    assert.equal(fetchedAgain, false, "the 304-provided max-age governs the refreshed representation");
});

test("304 no-store retires the restored body and its validators from the next request", async () => {
    const stored = stampedHeader(1000, '\ncache-control: no-cache\netag: "v1"');
    const { ctx, inspect } = makeCtx(priorEntry("cached", "text/plain", stored));
    await withTtl("60000", async () => {
        await withFetch(async () => new Response(null, {
            status: 304,
            headers: { "cache-control": "no-store", etag: '"v1"' },
        }), async () => {
            await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/retired", "/retired")),
                ctx,
            );
        });
    });
    const refreshedHeader = inspect().storedEntry?.channels.header?.content ?? "";
    assert.match(refreshedHeader, /^cache-control: no-store$/m);

    const { ctx: nextCtx } = makeCtx(priorEntry("cached", "text/plain", refreshedHeader));
    let conditional = false;
    await withTtl("60000", async () => {
        await withFetch(async (_url, init) => {
            const headers = new Headers(init?.headers);
            conditional = headers.has("if-none-match") || headers.has("if-modified-since");
            return new Response("new body", { headers: { "content-type": "text/plain" } });
        }, async () => {
            await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/retired", "/retired")),
                nextCtx,
            );
        });
    });
    assert.equal(conditional, false);
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
                (await prepareRepresentation(new Http(),
                    readStmt(urlTarget("https://example.com/paper.pdf", "/paper.pdf")),
                    ctx,
                )).status,
                200,
            );
        });
    });

    assert.equal(fetched, true);
    assert.equal(conditional, false, "a validator cannot certify output from a different projection");
    assert.equal(inspect().storedEntry?.channels.body?.content, "new projection");
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
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/materialized", "/materialized")), ctx);
        });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().storedEntry?.channels.body?.content, "materialized");
});

test("TTL: a completed empty GET is a reusable representation", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("", "text/plain", stampedHeader(1000)));
    let fetched = false;
    await withTtl("60000", async () => {
        await withFetch((async () => { fetched = true; throw new Error("must not fetch"); }) as unknown as typeof fetch, async () => {
            assert.equal(await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/empty", "/empty")), ctx).then((r) => r.status), 200);
        });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().opened, null);
    assert.equal(inspect().storedEntry?.channels.body?.content, "");
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
                await prepareRepresentation(new Http(), readStmt(urlTarget(`https://example.com/${state}`, `/${state}`)), ctx);
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
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
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
            return new Response(null, {
                status: 304,
                statusText: "Not Modified",
                headers: { etag: '"empty"' },
            });
        }) as typeof fetch, async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/empty", "/empty")), ctx);
        });
    });
    assert.equal(seenINM, '"empty"');
    assert.equal(inspect().wrote?.entry.channels.body?.content, "");
    assert.equal(inspect().opened, null);
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
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        });
    });
    assert.equal(fetched, true);
});

test("TTL: an unmarked authored entry remains outside HTTP acquisition", async () => {
    const { ctx, inspect } = makeCtx(priorEntry(
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
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/m", "/m")), ctx);
        });
    });
    assert.equal(fetched, false);
    assert.equal(conditional, false);
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().storedEntry?.channels.body?.content, "materialized");
});

test("TTL: explicit 0 disables the window — fresh stamp still revalidates", async () => {
    const { ctx } = makeCtx(priorEntry("cached", "text/plain", stampedHeader(1000, "\netag: \"v1\"")));
    let fetched = false;
    const probe = async () => {
        fetched = true;
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    };
    await withTtl("0", async () => {
        await withFetch(probe as typeof fetch, async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        });
    });
    assert.equal(fetched, true);
});

test("TTL: unset crashes naming the var (floor-set knob, no silent default)", async () => {
    const { ctx } = makeCtx(priorEntry("cached", "text/plain", stampedHeader(1000)));
    await withTtl(undefined, async () => {
        await assert.rejects(
            prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx),
            /PLURNK_SCHEMES_HTTP_TTL_MS is unset/,
        );
    });
});

test("stamp: #writeHeader materializes x-plurnk-fetched-at; 304 re-serve refreshes it", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["x"], { "content-type": "text/plain" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/s", "/s")), ctx);
    });
    const header = inspect().storedEntry?.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-fetched-at: \d{4}-/m); // stamped at materialization

    const old = stampedHeader(500_000, "\netag: \"v1\"");
    const { ctx: ctx2, inspect: inspect2 } = makeCtx(priorEntry("cached", "text/plain", old));
    await withTtl("0", async () => {
        await withFetch((async () => new Response(null, {
            status: 304,
            headers: { etag: '"v1"' },
        })) as unknown as typeof fetch, async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/s", "/s")), ctx2);
        });
    });
    const served = inspect2().storedEntry?.channels.header?.content ?? "";
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
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/method", "/method")), ctx);
    });
    const header = inspect().storedEntry?.channels.header?.content ?? "";
    assert.deepEqual(
        [...header.matchAll(/^x-plurnk-request-method:[ \t]*(.+)$/gim)].map((match) => match[1].trim()),
        ["POST", "GET"],
    );
});

// ── wire identity ───────────────────────────────────────────────────────────
test("byte path sends the default web UA, not Node's automated-client default", async () => {
    const { ctx } = makeCtx();
    let ua = "";
    const probe = async (_u: string | URL | Request, init?: RequestInit) => {
        ua = new Headers(init?.headers).get("user-agent") ?? "";
        return new Response("x", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withFetch(probe as typeof fetch, async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://api.example.com/d.json", "/d.json")), ctx);
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
        await prepareRepresentation(new Http(), readStmt(target), ctx);
    });
    assert.equal(ua, "curl/8");
});

// ── cancellation ──────────────────────────────────────────────────────────

// ── llms.txt companion ({§http-llms-txt}) ───────────────────────────────

test("{§http-llms-txt} a successful GET piggybacks the origin's llms.txt exactly once per window", async () => {
    const writes: string[] = [];
    const { ctx } = makeCtx(null, {
        write: async (pathname) => {
            writes.push(pathname);
            return { status: 201, created: true, entryId: 1 };
        },
    });
    const http = new Http();
    const target = urlTarget("https://example.com/guide/page", "/guide/page");
    let llmsRequests = 0;
    await withFetch(async (input) => {
        const url = String(input);
        if (url.endsWith("/llms.txt")) {
            llmsRequests += 1;
            return new Response("# llms\n\nUseful page summaries.", { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response("## Page body", { status: 200, headers: { "content-type": "text/markdown" } });
    }, async () => {
        assert.equal((await prepareRepresentation(http, readStmt(target), ctx)).status, 200);
        assert.equal((await prepareRepresentation(http, readStmt(target), ctx)).status, 200);
    }, true, true);
    assert.equal(llmsRequests, 1, "one companion probe per origin per TTL window");
    assert.deepEqual(writes, [
        "/example.com/guide/page",
        "/example.com/llms.txt",
        "/example.com/guide/page",
    ], "the companion materializes as its own origin entry");
});

test("{§http-llms-txt} a missing llms.txt is quiet, non-recurring, and never fails the READ", async () => {
    const writes: string[] = [];
    const { ctx } = makeCtx(null, {
        write: async (pathname) => {
            writes.push(pathname);
            return { status: 201, created: true, entryId: 1 };
        },
    });
    const http = new Http();
    const target = urlTarget("https://example.com/plain", "/plain");
    let llmsRequests = 0;
    await withFetch(async (input) => {
        const url = String(input);
        if (url.endsWith("/llms.txt")) {
            llmsRequests += 1;
            return new Response(null, { status: 404 });
        }
        return new Response("plain body", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
        assert.equal((await prepareRepresentation(http, readStmt(target), ctx)).status, 200);
        assert.equal((await prepareRepresentation(http, readStmt(target), ctx)).status, 200);
    }, true, true);
    assert.equal(llmsRequests, 1, "the failed probe is remembered, not retried");
    assert.deepEqual(writes, ["/example.com/plain", "/example.com/plain"], "no companion entry is fabricated");
});
