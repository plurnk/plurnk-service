import test from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LiveAcquisitions } from "./HttpShared.ts";
import MaterializerRegistry from "./Materializer.ts";
import {
    ProjectionInputLimitError,
    Results,
    type EntryStorageWriteResult,
    type SchemeCtx,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import Http from "./Http.ts";
import WebFetcher, { MATERIALIZER_ENV } from "./WebFetcher.ts";
import {
    STUB_DIR,
    editSettled,
    editStmt,
    findStmt,
    flush,
    httpSend,
    killSettled,
    killStmt,
    makeCtx,
    mockFetch,
    prepareExactFind,
    prepareRepresentation,
    priorEntry,
    projectionCaps,
    readStmt,
    registerMaterializerStub,
    sendSettled,
    sendStmt,
    urlTarget,
    withFetch,
} from "../test/harness.ts";
import { requestUrl } from "../../scripts/lib/test-fetch.ts";

registerMaterializerStub();

// ── manifest ──────────────────────────────────────────────────────────────
test("{§scheme-operation-dispatch}: Http publishes its WebFetcher as the framework's web materializer", () => {
    const http = new Http();
    assert.ok(http.webMaterializer instanceof WebFetcher, "the published materializer is the handler's own checked WebFetcher");
    for (const method of ["fetch", "materialize", "materializedChannels"] as const) {
        assert.equal(typeof http.webMaterializer[method], "function", `${method} is on the published contract`);
    }
});

test("{§http-lifecycle} manifest: name https (plain http folds in, #340), default channel body, web trait, network-volatile", () => {
    assert.equal(Http.manifest.name, "https");
    assert.equal(Http.manifest.authority, "resource");
    assert.equal(Http.manifest.glyph, "🌐");
    assert.equal(Http.manifest.defaultChannel, "body");
    assert.deepEqual(Http.manifest.traits, ["web"]);
    assert.equal(Http.manifest.volatile, true);
    assert.equal(Http.manifest.metadataModifier, true);
    assert.deepEqual(Object.keys(Http.manifest.channels).toSorted(), ["body", "header", "readable"]);
});

test("{§http-lifecycle} manifest: documentation is loaded verbatim from docs/https.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const fromFile = await readFile(new URL("../docs/https.md", import.meta.url), "utf-8");
    assert.equal(Http.manifest.documentation, fromFile);
    assert.match(Http.manifest.documentation ?? "", /^# https:\/\//);
    assert.match(Http.manifest.documentation ?? "", /^## Summary$/m);
    for (const op of ["READ", "EDIT", "SEND"]) assert.ok(fromFile.includes(`\`\`\`${op} (`), `${op} remains illustrated in the discoverable reference`);
});

test("{§http-host-policy} ready validates the fetch ceiling without making a provider request", async () => {
    const originalTimeout = process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT;
    let calls = 0;
    try {
        await withFetch((async () => {
            calls += 1;
            throw new Error("readiness must not call the materializer");
        }), async () => {
            process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT = "0";
            await assert.rejects(new Http().ready(), /PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT must be a safe integer of at least 1/);
        });
        assert.equal(calls, 0);
    } finally {
        if (originalTimeout === undefined) delete process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT;
        else process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT = originalTimeout;
    }
});

test("{§http-lifecycle} exact FIND preparation materializes an exact URL through the checked readable path", async () => {
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
    assert.equal(inspect().wrote?.pathname, "/dist/index.json");
    assert.equal(inspect().wrote?.entry.channels.body?.content, '{\n  "version": "24.18.0"\n}');
    assert.equal(inspect().wrote?.entry.channels.body?.mimetype, "application/json");
});

test("{§channel-selection} exact FIND preparation preserves a provider-only page's unavailable source channel", async () => {
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
    }), async () => {
        const prepared = await prepareExactFind(new Http(), findStmt(target), ctx);
        assert.equal(prepared.status, 200);
    });

    // {§channel-selection} — the materializer's text is `readable`; the page's source is `body`,
    // errored here because the origin never answered.
    assert.equal(inspect().wrote?.entry.channels.readable?.content, "provider body");
    const source = inspect().wrote?.entry.channels.body;
    assert.equal(source?.content, "");
    assert.equal(source?.mimetype, "text/html");
    assert.equal(source?.state, "errored");
    assert.equal(source?.producerResult?.status, 502);
    assert.equal(
        source?.producerResult?.problem?.type,
        "https://problems.plurnk.xyz/scheme/http/fetch-failed",
        "the source channel carries the origin's own failure",
    );
});

test("{§http-lifecycle} exact FIND preparation persists a readable binary projection with source and projection evidence", async () => {
    const projection = projectionCaps({
        async isBinary(mimetype) { return mimetype === "application/pdf"; },
        async binary(chunks, mimetype) {
            const bytes: number[] = [];
            for await (const chunk of chunks) bytes.push(...chunk);
            assert.deepEqual(bytes, [1, 2, 3]);
            return { bytes: Uint8Array.from(bytes), projectionIdentity: "pdf-reader-v2", readable: {
                content: "projected PDF",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "pdf-reader-v2",
            } };
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
        content: "",
        bytes: Uint8Array.of(1, 2, 3),
        mimetype: "application/pdf",
    });
    assert.deepEqual(inspect().wrote?.entry.channels.readable, {
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

test("{§http-lifecycle} exact FIND preparation reports the binary input ceiling as a typed 413 without persisting bytes", async (t) => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3, 4)); },
        cancel() { cancelled = true; },
    });
    const projection = projectionCaps({
        async isBinary() { return true; },
        async binary() {
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
    assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/scheme/http/projection-input-limit");
    assert.equal(result?.problem?.mimetype, "application/pdf");
    assert.equal(result?.problem?.maximumBytes, 3);
    assert.equal(result?.problem?.observedBytes, 4);
    assert.equal(result?.problem?.retryable, false);
    assert.equal(cancelled, true);
    assert.equal(inspect().wrote, null);
    assert.equal(diagnostics.length, 0, "an enforced input ceiling is not an internal defect");
});

test("{§http-lifecycle} exact FIND preparation treats XHTML and a present empty projection as successful materialization", async () => {
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
    assert.deepEqual(inspect().wrote?.entry.channels.readable, { content: "", mimetype: "text/markdown" });
    assert.deepEqual(inspect().wrote?.entry.channels.body, {
        content: "<html><body></body></html>",
        mimetype: "application/xhtml+xml",
    });
});

test("{§http-lifecycle} exact FIND preparation persists an absent final HTML projection as the readable channel's exact 422", async () => {
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
    assert.equal(inspect().wrote?.entry.channels.body?.content, "<html><body><div></div></body></html>", "the source is whole");
    const readable = inspect().wrote?.entry.channels.readable;
    assert.equal(readable?.content, "");
    assert.equal(readable?.state, "errored");
    assert.equal(readable?.producerResult?.status, 422);
    assert.equal(
        readable?.producerResult?.problem?.type,
        "https://problems.plurnk.xyz/scheme/http/no-readable-projection",
    );
});

test("{§http-lifecycle} exact FIND preparation reports a projection exception as 500 and logs its cause", async (t) => {
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
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/http/projection-failed");
            assert.equal(result.problem?.stage, "projection");
            assert.equal(result.problem?.retryable, false);
            assert.doesNotMatch(result.problem?.detail ?? "", /reader implementation failed/);
        },
    );
    assert.equal(inspect().wrote, null);
    assert.equal((diagnostics[0]?.[1] as { error?: Error })?.error?.cause, cause);
});

test("{§http-lifecycle} exact FIND preparation reports caller cancellation during origin acquisition as 499", async () => {
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
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/http/cancelled");
    assert.equal(result.problem?.retryable, false);
    assert.equal(inspect().wrote, null);
});

test("{§http-lifecycle} exact FIND preparation does not relabel an unrelated failure after a later caller abort", async (t) => {
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

test("{§http-lifecycle} exact FIND preparation rewrites acquisition but stores the addressed GitHub identity", async () => {
    const { ctx, inspect } = makeCtx();
    let seenUrl = "";
    const blob = "https://github.com/nodejs/node/blob/main/src/node_version.h";
    await withFetch(async (url) => {
        seenUrl = requestUrl(url);
        return new Response("// source", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
        const prepared = await prepareExactFind(new Http(),
            findStmt(urlTarget(blob, "/nodejs/node/blob/main/src/node_version.h")),
            ctx,
        );
        assert.equal(prepared.status, 200);
    });
    assert.equal(seenUrl, "https://raw.githubusercontent.com/nodejs/node/main/src/node_version.h");
    assert.equal(inspect().wrote?.pathname, "/nodejs/node/blob/main/src/node_version.h");
});

test("{§http-lifecycle} exact FIND preparation preserves an exact storage-read failure without fetching", async () => {
    const failure = Results.failure(
        "scheme:test",
        "storage-unavailable",
        503,
        "The entry store is unavailable.",
        { entry: null },
        { stage: "storage", retryable: true },
    );
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

test("{§http-lifecycle} exact FIND preparation preserves an exact storage-write failure", async () => {
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

test("{§http-lifecycle} exact FIND preparation preserves an unmarked authored entry without network acquisition", async () => {
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
test("{§channel-selection} finite GET materializes complete channels without opening a subscription", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["x"], { "content-type": "text/plain" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/robots.txt", "/robots.txt")), ctx);
    });
    const { wrote, seq } = inspect();
    assert.deepEqual(seq, ["write"]);
    assert.equal(wrote?.pathname, "/robots.txt");
    // {§channel-selection} — a plain-text response has no projection: body and header, nothing else.
    assert.deepEqual(Object.keys(wrote.entry.channels).toSorted(), ["body", "header"]);
    assert.deepEqual(wrote.entry.channels.body, { content: "x", mimetype: "text/plain" });
    assert.match(wrote.entry.channels.header?.content ?? "", /^HTTP 200 OK/m);
});

test("{§http-lifecycle} SEND: also materializes the entry before subscribing (shares #fetchStream)", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["ok"], { "content-type": "text/plain" }), async () => {
        await httpSend(sendStmt(urlTarget("https://example.com/p", "/p"), "payload"), ctx);
    });
    const { wrote, seq } = inspect();
    assert.deepEqual(seq.slice(0, 2), ["write", "open"]);
    assert.equal(wrote?.pathname, "/p");
});

test("{§http-lifecycle} JSON mutation responses publish formatted documents without changing the request", async () => {
    const { ctx, inspect } = makeCtx();
    const request = '{"indent":    "is source"}';
    let submitted: BodyInit | null | undefined;
    const respond = mockFetch(200, "OK", ['{"id":9007199254740993,', '"nested":{"ok":true}}'], { "content-type": "application/problem+json" });
    await withFetch(async (_input, init) => {
        submitted = init?.body;
        return respond();
    }, async () => {
        await httpSend(sendStmt(urlTarget("http://example.com/x", "/x"), request), ctx);
    });
    assert.equal(submitted, request);
    assert.deepEqual(inspect().chunks.filter(({ channel }) => channel === "body"), [{
        channel: "body",
        chunk: '{\n  "id": 9007199254740993,\n  "nested": {\n    "ok": true\n  }\n}',
        mimetype: "application/problem+json",
    }]);
    assert.equal(inspect().closed?.result.status, 200);
});

test("{§http-lifecycle} interrupted JSON mutation responses preserve received text and the acquisition error", async () => {
    const { ctx, inspect } = makeCtx();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('{"partial":'));
            else controller.error(new Error("response interrupted"));
        },
    });
    await withFetch(async () => new Response(stream, { headers: { "content-type": "application/json" } }), async () => {
        const result = await httpSend(sendStmt(urlTarget("http://example.com/x", "/x"), "task"), ctx);
        assert.equal(result.status, 502);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/http/fetch-failed");
    });
    assert.equal(inspect().chunks.filter(({ channel }) => channel === "body").map(({ chunk }) => chunk).join(""), '{"partial":');
    assert.equal(inspect().closed?.result.status, 502);
});

// ── READ streaming ────────────────────────────────────────────────────────
test("{§http-lifecycle} finite GET stores its complete body and returns ready", async () => {
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

test("{§http-status} finite HTTP errors preserve their body and exact default-channel outcome", async () => {
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
        "https://problems.plurnk.xyz/scheme/http/http-response-status",
    );
});

test("{§http-lifecycle} READ uses canonical authority/query identity while metadata and fragment stay out of transport", async () => {
    const { ctx, inspect } = makeCtx();
    let seenUrl = "";
    let seenHeaders: HeadersInit | undefined;
    const target = urlTarget(
        "https://example.com:8443/x?b=2&a=1&a=3#body",
        "/x",
        "body",
    );
    await withFetch(async (url, init) => {
        seenUrl = requestUrl(url);
        seenHeaders = init?.headers;
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
        const result = await prepareRepresentation(new Http(), readStmt(target, null, ["{\"Authorization\":\"Bearer example\"}"]), ctx);
        assert.equal(result.status, 200);
    });
    assert.equal(seenUrl, "https://example.com:8443/x?b=2&a=1&a=3");
    assert.equal(new Headers(seenHeaders).get("Authorization"), "Bearer example");
    assert.equal(inspect().wrote?.pathname, "/x?b=2&a=1&a=3");
    assert.equal(inspect().opened, null);
});
test("{§http-lifecycle} HTTP userinfo is rejected without transport or secret-bearing diagnostics", async () => {
    const { ctx } = makeCtx();
    let fetched = false;
    const target = urlTarget("https://alice:secret@example.com/x", "/x");
    await withFetch(async () => {
        fetched = true;
        return new Response("wrong");
    }, async () => {
        const result = await prepareRepresentation(new Http(), readStmt(target), ctx);
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/http/userinfo-not-allowed");
        assert.equal(result.problem?.target, "https://example.com/x");
        assert.doesNotMatch(JSON.stringify(result), /alice|secret/);
    });
    assert.equal(fetched, false);
});

test("{§http-lifecycle} READ/POST/PUT/DELETE: explicit loopback targets use the native transport", async () => {
    const requests: Array<{ url: string; method: string; redirect: RequestRedirect | undefined }> = [];
    await withFetch((async (input, init) => {
        requests.push({
            url: requestUrl(input),
            method: init?.method ?? "GET",
            redirect: init?.redirect,
        });
        return new Response("private", {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    }), async () => {
        const target = urlTarget("http://127.0.0.1/private", "/private");
        const operations = [
            (http: Http, ctx: SchemeCtx) => prepareRepresentation(http, readStmt(target), ctx),
            (http: Http, ctx: SchemeCtx) => sendSettled(http, sendStmt(target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => editSettled(http, editStmt(target, "body"), ctx),
            (http: Http, ctx: SchemeCtx) => killSettled(http, killStmt(target, null, ["{\"remote\":true}"]), ctx),
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

test("{§http-lifecycle} preparation is line-scope-blind and leaves selection to core", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("complete page", "text/markdown", ""));
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        const statement = readStmt(urlTarget("https://example.com/x", "/x"), { marks: [2, 4] });
        const result = await prepareRepresentation(new Http(), statement, ctx);
        assert.equal(result.status, 200);
        assert.equal(inspect().storedEntry?.channels.body.content, "complete page", "preparation preserves the complete representation");
    });
    assert.equal(fetched, false, "a range observation never re-enters the network path");
    assert.equal(inspect().wrote, null, "the materialized entry is not replaced with a stream seed");
    assert.equal(inspect().opened, null, "no subscription is opened for a stored range");
});

test("{§http-lifecycle} preparation is channel-blind even when an auxiliary channel was authored", async () => {
    const statement = readStmt(
        urlTarget("https://example.com/x#header", "/x", "header"),
        { marks: [2] },
    );
    const { ctx, inspect } = makeCtx(
        priorEntry("", "text/plain", "HTTP 204 No Content\ncontent-type: text/plain"),
    );
    let fetched = false;
    await withFetch(async () => { fetched = true; return new Response("wrong"); }, async () => {
        assert.equal((await prepareRepresentation(new Http(), statement, ctx)).status, 200);
    });
    assert.equal(inspect().storedEntry?.channels.header.content, "HTTP 204 No Content\ncontent-type: text/plain");
    assert.equal(inspect().observedStorageRead, "/x");
    assert.equal(fetched, false, "a scoped auxiliary-channel observation never enters the network path");
});

test("{§http-lifecycle} preparation leaves out-of-range selection to core", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("complete page", "text/markdown", ""));
    const result = await prepareRepresentation(new Http(),
        readStmt(urlTarget("https://example.com/x", "/x"), { marks: [30, 100] }),
        ctx,
    );
    assert.equal(result.status, 200);
    assert.equal(inspect().storedEntry?.channels.body.content, "complete page");
    assert.equal(inspect().wrote, null);
});

test("{§http-lifecycle} channel selection cannot suppress representation acquisition", async () => {
    const { ctx, inspect } = makeCtx();
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
    assert.equal(inspect().observedStorageRead, "/x");
    assert.equal(inspect().storedEntry?.channels.body.content, "complete");
    assert.equal(inspect().opened, null);
});

test("{§http-lifecycle} an unknown channel is withheld from the producer and rejected later by core", async () => {
    const { ctx, inspect } = makeCtx();
    let fetched = false;
    await withFetch(async () => {
        fetched = true;
        return new Response("body", { headers: { "content-type": "text/plain" } });
    }, async () => {
        const result = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/x", "/x", "raw")), ctx);
        assert.equal(result.status, 200);
    });
    assert.equal(fetched, true);
    assert.equal(inspect().opened, null);
});

test("{§http-lifecycle} READ: non-HTML body is labelled with its real content-type", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ['{"a":1}'], { "content-type": "Application/JSON; charset=utf-8" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/d.json", "/d.json")), ctx);
    });
    assert.equal(inspect().wrote?.entry.channels.body?.mimetype, "application/json");
});

test("{§http-lifecycle} READ: textual bytes follow Fetch UTF-8 decoding regardless of charset metadata", async () => {
    const { ctx, inspect } = makeCtx();
    const windows1252 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    await withFetch(mockFetch(200, "OK", [windows1252], {
        "content-type": "text/plain; charset=windows-1252",
    }), async () => {
        assert.equal(
            (await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/plain.txt", "/plain.txt")), ctx)).status,
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

test("{§http-lifecycle} READ: an unparseable Content-Type is an unknown binary representation", async () => {
    const { ctx, inspect } = makeCtx();
    let result: Awaited<ReturnType<typeof prepareRepresentation>> | undefined;
    await withFetch(mockFetch(200, "OK", ["not trustworthy"], {
        "content-type": "text/plain garbage",
    }), async () => {
        result = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/bad", "/bad")), ctx);
    });

    assert.equal(result?.status, 200);
    assert.deepEqual(inspect().wrote?.entry.channels.body?.bytes, Buffer.from("not trustworthy"));
    assert.equal(inspect().wrote?.entry.channels.body?.mimetype, "application/octet-stream");
    assert.equal(inspect().wrote?.entry.channels.readable, undefined);
});

test("{§http-lifecycle} SEND: a binary response retains the complete bytes and response headers without requiring a reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
            controller.close();
        },
        cancel() { cancelled = true; },
    });
    const { ctx, inspect } = makeCtx();
    let result: SchemeResult | undefined;
    await withFetch(async () => new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "image/png" },
    }), async () => {
        result = await httpSend(sendStmt(urlTarget("https://example.com/logo.png", "/logo.png"), "create"), ctx);
    });

    assert.equal(result?.status, 102);
    assert.equal(result?.problem, undefined);
    assert.equal(cancelled, false);
    assert.deepEqual(inspect().wrote?.entry.channels.body, {
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]), content: "", mimetype: "image/png", state: "active",
    });
    assert.equal(inspect().wrote?.entry.channels.readable, undefined);
    assert.equal(inspect().closed?.result.status, 200);
    assert.match(inspect().wrote?.entry.channels.header?.content ?? "", /^HTTP 200 OK/m);
    assert.match(inspect().chunks.find(({ channel }) => channel === "header")?.chunk ?? "", /^HTTP 200 OK/m);
});

test("{§http-lifecycle} READ: a readable binary response publishes its source bytes, readable projection and evidence", async () => {
    const projection = projectionCaps({
        async isBinary(mimetype) { return mimetype === "application/pdf"; },
        async binary(chunks, mimetype) {
            const bytes: number[] = [];
            for await (const chunk of chunks) bytes.push(...chunk);
            assert.deepEqual(bytes, [37, 80, 68, 70]);
            return { bytes: Uint8Array.from(bytes), projectionIdentity: "pdf-reader-v3", readable: {
                content: "# projected paper",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "pdf-reader-v3",
            } };
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
        content: "",
        bytes: Uint8Array.of(37, 80, 68, 70),
        mimetype: "application/pdf",
    });
    assert.deepEqual(inspect().wrote?.entry.channels.readable, {
        content: "# projected paper",
        mimetype: "text/markdown",
    });
    const header = inspect().wrote?.entry.channels.header?.content ?? "";
    assert.match(header, /^content-type: application\/pdf$/m);
    assert.match(header, /^x-plurnk-projection-id: pdf-reader-v3$/m);
    assert.equal(inspect().closed, null);
});

test("{§http-lifecycle} READ: a binary projection input ceiling leaves a typed marker and closes with 413", async (t) => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3, 4)); },
        cancel() { cancelled = true; },
    });
    const projection = projectionCaps({
        async isBinary() { return true; },
        async binary() {
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
    assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/scheme/http/projection-input-limit");
    assert.equal(result?.problem?.maximumBytes, 3);
    assert.equal(result?.problem?.observedBytes, 4);
    assert.equal(inspect().wrote, null);
    assert.equal(cancelled, true);
    assert.equal(inspect().closed, null);
    assert.equal(diagnostics.length, 0);
});

test("{§revalidation} READ: an undeclared body retains application/octet-stream bytes, not guessed text", async () => {
    const { ctx, inspect } = makeCtx();
    let result: Awaited<ReturnType<typeof prepareRepresentation>> | undefined;
    await withFetch(async () => new Response(new Uint8Array([0x68, 0x69]), {
        status: 200,
        statusText: "OK",
    }), async () => {
        result = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/unknown", "/unknown")), ctx);
    });

    assert.equal(result?.status, 200);
    assert.equal(inspect().wrote?.entry.channels.body?.mimetype, "application/octet-stream");
    assert.deepEqual(inspect().wrote?.entry.channels.body?.bytes, Buffer.from([0x68, 0x69]));
    assert.equal(inspect().wrote?.entry.channels.readable, undefined);
});

// ── server-sent events {§revalidation} ─────────────────────────────────────────────
const sseBody = (chunks: Array<{ channel: string; chunk: string }>) =>
    chunks.filter((c) => c.channel === "body").map((c) => c.chunk);

test("{§http-lifecycle} READ SSE: each event's data becomes one body chunk, framing stripped", async () => {
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

test("{§http-lifecycle} READ SSE: returns 102 after acquisition while the origin stream remains open", async () => {
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

test("{§http-lifecycle} READ SSE: multi-line data joins with \\n into a single event", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: a\ndata: b\n\n"], { "content-type": "text/event-stream; charset=utf-8" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    assert.deepEqual(sseBody(inspect().chunks), ["a\nb\n"]);
});

test("{§http-lifecycle} READ SSE: comment and metadata-only frames drop; only data dispatches", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", [": keep-alive\n\n", "event: greet\nid: 7\ndata: payload\n\n"], { "content-type": "text/event-stream" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    const { chunks, closed } = inspect();
    assert.deepEqual(sseBody(chunks), ["payload\n"]);
    assert.equal(closed?.summary, "SSE stream; 1 events");
});

test("{§http-lifecycle} READ SSE: an event split across network chunks reassembles", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: par", "tial\n", "\n"], { "content-type": "text/event-stream" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    assert.deepEqual(sseBody(inspect().chunks), ["partial\n"]);
});

test("{§http-lifecycle} READ SSE: CRLF-framed events parse (\\r normalized)", async () => {
    const { ctx, inspect, awaitClosed } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["data: crlf\r", "\n\r", "\n"], { "content-type": "text/event-stream" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/sse", "/sse")), ctx);
        await awaitClosed();
    });
    assert.deepEqual(sseBody(inspect().chunks), ["crlf\n"]);
});

test("{§http-lifecycle} READ SSE: an oversized incomplete event fails the remote stream", async () => {
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
            assert.equal(terminal.result.problem?.retryable, false, "a partially consumed stream is not replay-safe");
        });
        assert.equal(inspect().closed?.result.status, 502);
        assert.equal(inspect().closed?.result.problem?.type, "https://problems.plurnk.xyz/scheme/http/fetch-failed");
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS;
        else process.env.PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS = previous;
    }
});

test("{§http-lifecycle} READ SSE: cancellation after acquisition settles the retained stream at 499", async () => {
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
        assert.equal(terminal.result.problem?.type, "https://problems.plurnk.xyz/scheme/http/cancelled");
    });
});

test("{§revalidation} HTML preparation keeps the server source as body while readable carries the projection", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["<html><body><h1>Hello</h1></body></html>"], { "content-type": "text/html; charset=utf-8" }), async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/spa", "/spa")), ctx);
        assert.equal(r.status, 200);
    });
    assert.deepEqual(inspect().wrote?.entry.channels.readable, {
        content: "Hello",
        mimetype: "text/markdown",
    });
    assert.deepEqual(inspect().wrote?.entry.channels.body, {
        content: "<html><body><h1>Hello</h1></body></html>",
        mimetype: "text/html",
    });
});

test("{§http-lifecycle} READ: a present empty HTML projection succeeds and retains its HTML evidence", async () => {
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
    assert.deepEqual(inspect().wrote?.entry.channels.readable, {
        content: "",
        mimetype: "text/markdown",
    });
    assert.equal(inspect().wrote?.entry.channels.body?.content, html);
    assert.equal(inspect().closed, null);
});

test("READ: public HTML uses the materializer Markdown and retains origin, request, and credit evidence ({§http-lifecycle})", async () => {
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
        new Response(html, { status: 200, statusText: "OK", headers: { "content-type": "application/xhtml+xml" } })), async () => {
        const result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/stub", "/stub")),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    assert.deepEqual(inspect().wrote?.entry.channels.readable, {
        content: "# Stub body",
        mimetype: "text/markdown",
    });
    assert.deepEqual(inspect().wrote?.entry.channels.body, {
        content: html,
        mimetype: "application/xhtml+xml",
    });
    const header = inspect().wrote?.entry.channels.header?.content ?? "";
    assert.match(header, /^HTTP 200 OK/m);
    assert.match(header, /^x-plurnk-materializer-id: stub-extract:v1$/m);
    assert.match(header, /^x-plurnk-stub-request-id: req-direct$/m);
    assert.match(header, /^x-plurnk-stub-credits: 0\.2$/m);
});

test("{§channel-selection} READ: negotiated origin Markdown is the source itself, one request, no projection, no materializer", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { ctx, inspect } = makeCtx();
    const accepts: string[] = [];
    await withFetch((async (_input, init) => {
        accepts.push(new Headers(init?.headers).get("accept") ?? "");
        return new Response("# Origin Markdown", {
            status: 200,
            headers: { "content-type": "text/markdown", vary: "Accept" },
        });
    }), async () => {
        const result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/markdown", "/markdown")),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    // {§channel-selection} — the origin sent readable text; nothing to project, no HTML variant to chase.
    assert.deepEqual(accepts.map((accept) => accept.split(",")[0]), ["text/markdown"], "exactly one request");
    assert.deepEqual(Object.keys(inspect().wrote?.entry.channels ?? {}).toSorted(), ["body", "header"]);
    assert.equal(inspect().wrote?.entry.channels.body?.content, "# Origin Markdown");
    assert.equal(inspect().wrote?.entry.channels.body?.mimetype, "text/markdown");
    const header = inspect().wrote?.entry.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-materializer-id: origin-markdown:v1$/m);
    assert.equal(inspect().closed, null);
});

for (const selected of ["body", "readable", "header"] as const) {
    test(`{§http-lifecycle} preparation with authored #${selected} persists independent materializer channel outcomes`, async () => {
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
        })), async () => {
            const result = await prepareRepresentation(new Http(),
                readStmt(urlTarget(
                    "https://example.com/hard-provider",
                    "/hard-provider",
                    selected === "body" ? null : selected,
                )),
                ctx,
            );
            assert.equal(result.status, 200);
        });
        // {§channel-selection} — the hard materializer failure is the readable channel's; the source lands whole.
        assert.equal(inspect().wrote?.entry.channels.readable?.state, "errored");
        assert.equal(inspect().wrote?.entry.channels.readable?.producerResult?.status, 502);
        assert.equal(inspect().wrote?.entry.channels.body?.content, "<html><body>Durable source</body></html>");
        assert.equal(inspect().closed, null);
    });
}

test("{§http-lifecycle} READ: recoverable materializer outcome uses the local floor with explicit terminal 203", async () => {
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
    })), async () => {
        const result = await prepareRepresentation(new Http(),
            readStmt(urlTarget("https://example.com/recover", "/recover")),
            ctx,
        );
        assert.equal(result.status, 200);
    });
    assert.equal(inspect().wrote?.entry.channels.readable?.content, "local floor");
    assert.equal(inspect().wrote?.entry.channels.readable?.producerResult?.status, 203);
    assert.equal(inspect().wrote?.entry.channels.body?.content, "<html><body>Origin</body></html>");
    const header = inspect().wrote?.entry.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-stub-request-id: req-recover$/m);
});

for (const selected of ["body", "readable"] as const) {
    test(`{§http-lifecycle} READ #${selected}: the materializer text may survive admitted origin transport failure`, async () => {
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
        }), async () => {
            const result = await prepareRepresentation(new Http(),
                readStmt(urlTarget(
                    "https://example.com/provider-only",
                    "/provider-only",
                    selected === "body" ? null : "readable",
                )),
                ctx,
            );
            assert.equal(result.status, 200);
        });
        assert.equal(inspect().wrote?.entry.channels.readable?.content, "provider-only body");
        assert.equal(inspect().wrote?.entry.channels.body?.state, "errored");
        assert.equal(inspect().wrote?.entry.channels.body?.producerResult?.status, 502);
        assert.equal(inspect().closed, null);
    });
}

test("{§http-lifecycle} READ: an absent HTML projection returns 422 and retains its HTML evidence", async () => {
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
    assert.equal(inspect().wrote?.entry.channels.readable?.producerResult?.status, 422);
    assert.equal(inspect().wrote?.entry.channels.body?.content, html);
    assert.match(inspect().wrote?.entry.channels.header?.content ?? "", /^HTTP 200 OK/m);
});

test("{§http-lifecycle} READ: a projection exception returns 500, retains evidence, and logs its cause", async (t) => {
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
    assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/scheme/http/projection-failed");
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().closed, null);
    assert.equal((diagnostics[0]?.[1] as { error?: Error })?.error?.cause, cause);
});

test("{§http-lifecycle} READ: non-url target → 400 with RFC 9457 Problem Details", async () => {
    const { ctx } = makeCtx();
    const r = await prepareRepresentation(new Http(), readStmt(null), ctx);
    assert.equal(r.status, 400);
    assert.equal(r.problem?.type, "https://problems.plurnk.xyz/scheme/http/bad-target");
});

test("{§http-lifecycle} READ: empty response body closes done without body chunks", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(204, "No Content", []), async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 200);
    });
    assert.equal(inspect().wrote?.entry.channels.body?.content, "");
    assert.equal(inspect().closed, null);
});

test("{§http-lifecycle} READ preserves an exact storage-read failure before acquisition", async () => {
    const failure = Results.failure(
        "scheme:test",
        "storage-unavailable",
        503,
        "The entry store is unavailable.",
        { entry: null },
        { stage: "storage", retryable: true },
    );
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

test("{§http-lifecycle} GET preserves an exact materialization-write failure", async () => {
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

test("{§http-lifecycle} origin failure becomes durable body-channel producer evidence", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("http://example.com/x", "/x")), ctx);
        assert.equal(r.status, 200);
    });
    assert.equal(inspect().wrote?.entry.channels.body?.producerResult?.status, 502);
    assert.equal(
        inspect().wrote?.entry.channels.body?.producerResult?.problem?.type,
        "https://problems.plurnk.xyz/scheme/http/fetch-failed",
    );
    assert.equal(inspect().wrote?.entry.channels.body?.producerResult?.problem?.retryable, true, "GET acquisition is replay-safe");
});

test("{§http-lifecycle} READ: network failure bounds caught diagnostics in the exact Problem", async () => {
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

// ── wire identity ───────────────────────────────────────────────────────────
test("{§http-host-policy} byte path sends Plurnk's own identity, never a browser's", async () => {
    const { ctx } = makeCtx();
    let ua = "";
    const probe = async (_u: string | URL | Request, init?: RequestInit) => {
        ua = new Headers(init?.headers).get("user-agent") ?? "";
        return new Response("x", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withFetch(probe, async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://api.example.com/d.json", "/d.json")), ctx);
    });
    assert.match(ua, /^PlurnkBot\//u, "Plurnk says what it is");
    assert.doesNotMatch(ua, /Mozilla|Chrome|Safari/u, "and never claims to be a browser");
});

test("{§http-lifecycle} a model-supplied User-Agent metadata block overrides the default identity", async () => {
    const { ctx } = makeCtx();
    let ua = "";
    const probe = async (_u: string | URL | Request, init?: RequestInit) => {
        ua = new Headers(init?.headers).get("user-agent") ?? "";
        return new Response("x", { status: 200 });
    };
    const target = urlTarget("https://api.example.com/x", "/x");
    await withFetch(probe, async () => {
        await prepareRepresentation(new Http(), readStmt(target, null, ["{\"User-Agent\":\"curl/8\"}"]), ctx);
    });
    assert.equal(ua, "curl/8");
});

// ── cancellation ──────────────────────────────────────────────────────────

// ── llms.txt companion ({§http-lifecycle}) ───────────────────────────────

test("{§http-lifecycle} a successful GET piggybacks the origin's llms.txt exactly once per window", async () => {
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
        const url = requestUrl(input);
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
        "/guide/page",
        "/llms.txt",
        "/guide/page",
    ], "the companion materializes as its own origin entry");
});

test("{§http-lifecycle} the companion is the operator's to allow: switched off, a READ makes only its own request", async () => {
    const prior = process.env.PLURNK_SCHEMES_HTTP_LLMS_TXT;
    const requested: string[] = [];
    const { ctx } = makeCtx(null, { write: async () => ({ status: 201, created: true, entryId: 1 }) });
    try {
        process.env.PLURNK_SCHEMES_HTTP_LLMS_TXT = "0";
        await withFetch(async (input) => {
            requested.push(requestUrl(input));
            return new Response("## Page body", { status: 200, headers: { "content-type": "text/markdown" } });
        }, async () => {
            assert.equal((await prepareRepresentation(new Http(), readStmt(urlTarget("https://quiet.example/page", "/page")), ctx)).status, 200);
        }, true, true);
        assert.deepEqual(requested, ["https://quiet.example/page"]);
        process.env.PLURNK_SCHEMES_HTTP_LLMS_TXT = "maybe";
        // An invalid switch is the operator's mistake and fails by name, never quietly one way or the other.
        await withFetch(async () => new Response("x", { status: 200, headers: { "content-type": "text/markdown" } }), async () => {
            await assert.rejects(
                prepareRepresentation(new Http(), readStmt(urlTarget("https://loud.example/page", "/page")), ctx),
                /PLURNK_SCHEMES_HTTP_LLMS_TXT must be 0 or 1; got "maybe"/u,
            );
        }, true, true);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SCHEMES_HTTP_LLMS_TXT; else process.env.PLURNK_SCHEMES_HTTP_LLMS_TXT = prior;
    }
});

test("{§http-lifecycle} a missing llms.txt is quiet, non-recurring, and never fails the READ", async () => {
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
        const url = requestUrl(input);
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
    assert.deepEqual(writes, ["/plain", "/plain"], "no companion entry is fabricated");
});

test("{§revalidation}: address cancellation includes concurrent acquisitions without crossing workspaces", () => {
    const live = new LiveAcquisitions();
    const first = new AbortController();
    const second = new AbortController();
    const foreign = new AbortController();
    const key = LiveAcquisitions.key(1, "https://example.com/resource");
    const release = live.track(key, first);
    live.track(key, second);
    live.track(LiveAcquisitions.key(2, "https://example.com/resource"), foreign);
    assert.equal(live.cancel(key), true);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, true);
    assert.equal(foreign.signal.aborted, false);
    const next = new AbortController();
    live.track(key, next);
    release();
    assert.equal(live.cancel(key), true, "old cleanup cannot untrack a subsequent acquisition");
    assert.equal(next.signal.aborted, true);
    assert.equal(live.cancel(key), false);
});

test("{§http-lifecycle} a standard bundle uses lazy materializer discovery without a daemon module", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "materializer-extension-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plugin = join(root, "plugin");
    await mkdir(join(plugin, "ai.plurnk"), { recursive: true });
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "@plurnk/example-plugin", type: "module" }));
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "example-plugin",
        extensions: { "ai.plurnk": { kind: "http-materializer", materializers: [{ id: "fixture", module: "ai.plurnk/materializer.mjs" }] } },
    }));
    const registry = await new MaterializerRegistry().discover({ packageDirs: [{ dir: plugin, name: "@plurnk/example-plugin" }] });
    const found = registry.materializerFor("fixture");
    assert.ok(found, "discovery does not import the implementation");
    await writeFile(join(plugin, "ai.plurnk/materializer.mjs"), `export default {
        id: "fixture", eligible: () => "fixture:v1",
        extract: async () => ({ outcome: "success", body: "native body", identity: "fixture:v1", evidence: [] }),
    };`);
    assert.equal(await found.eligible("https://example.com/", {}), "fixture:v1");
    assert.deepEqual(await found.extract("https://example.com/", {}), {
        outcome: "success", body: "native body", identity: "fixture:v1", evidence: [],
    });
    assert.equal(await registry.discover({ packageDirs: [{ dir: plugin, name: "@plurnk/example-plugin" }] }), registry);
    assert.equal(await registry.materializerFor("fixture")?.eligible("https://example.com/", {}), "fixture:v1");
    const competitor = join(root, "competitor");
    await mkdir(competitor);
    await writeFile(join(competitor, "package.json"), JSON.stringify({
        name: "@plurnk/competitor", plurnk: { kind: "http-materializer", materializers: [{ id: "fixture", module: "unused.mjs" }] },
    }));
    await assert.rejects(new MaterializerRegistry().discover({ packageDirs: [
        { dir: plugin, name: "@plurnk/example-plugin" }, { dir: competitor, name: "@plurnk/competitor" },
    ] }), /claimed by both @plurnk\/example-plugin and @plurnk\/competitor/);
    await rm(join(plugin, "ai.plurnk/materializer.mjs"));
    await writeFile(join(root, "outside.mjs"), "throw new Error('must not import');");
    await symlink(join(root, "outside.mjs"), join(plugin, "ai.plurnk/materializer.mjs"));
    await assert.rejects(new MaterializerRegistry().discover({ packageDirs: [{ dir: plugin, name: "@plurnk/example-plugin" }] }),
        /native module resolves outside the plugin root/);
});
