// WebFetcher contract coverage {§prefetch}. Hermetic: mocked global fetch,
// and IP literals or explicit guard mocks (no DNS). Env from --env-file=.env.defaults.

import test, { after, before, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Guard from "./Guard.ts";
import MaterializerRegistry from "./Materializer.ts";
import WebFetcher, {
    MARKDOWN_ACCEPT,
    MATERIALIZER_ENV,
    MATERIALIZER_ID_HEADER,
    WebMaterializationError,
} from "./WebFetcher.ts";
import { MimetypeClassifier, type ProjectionCaps } from "@plurnk/plurnk-schemes";

const PUB = "https://93.184.216.34/x";
const STUB_DIR = resolve(import.meta.dirname, "..", "test", "fixtures", "materializer-stub");

const originalMaterializer = process.env[MATERIALIZER_ENV];
before(async () => {
    // Hermetic discovery: the stub fixture is the only materializer package the
    // registry sees; the singleton scan caches across the file.
    await MaterializerRegistry.current().discover({
        packageDirs: [{ dir: STUB_DIR, name: "@plurnk/test-materializer-stub" }],
    });
});
beforeEach(async () => {
    delete process.env[MATERIALIZER_ENV];
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void; calls: unknown[] } };
    __stub.set({ eligible: () => null, extract: async () => { throw new Error("stub: no behavior"); } });
    __stub.calls.length = 0;
});
after(() => {
    if (originalMaterializer === undefined) delete process.env[MATERIALIZER_ENV];
    else process.env[MATERIALIZER_ENV] = originalMaterializer;
});

const projectionCaps = (overrides: Partial<ProjectionCaps> = {}): ProjectionCaps => ({
    async readable() { return null; },
    async readableBytes() { return null; },
    async identity(mimetype) { return `${mimetype}-projection`; },
    async isBinary(mimetype) { return MimetypeClassifier.isBinary(mimetype); },
    ...overrides,
    parseIssues: overrides.parseIssues ?? (async () => undefined),
});
const PROJECTION = projectionCaps();

const withFetch = async (impl: typeof fetch, fn: () => Promise<void>) => {
    const orig = globalThis.fetch;
    globalThis.fetch = impl;
    try { await fn(); } finally { globalThis.fetch = orig; }
};
const resp = (body: string | Uint8Array<ArrayBuffer> | null, status: number, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers });

test("live public textual URL → { body, mimetype }", async () => {
    await withFetch((async () => resp('{"a":1}', 200, { "content-type": "application/json" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        const materialized = fetched === null ? null : await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, '{"a":1}');
        assert.equal(fetched?.mimetype, "application/json");
        assert.match(fetched?.header ?? "", /^HTTP 200 /);
        assert.match(fetched?.header ?? "", /^x-plurnk-request-method: GET$/m);
        assert.match(fetched?.header ?? "", /^x-plurnk-fetched-at:/m);
    });
});

test("the shared textual taxonomy accepts application/yaml", async () => {
    await withFetch((async () => resp("name: plurnk", 200, { "content-type": "application/yaml" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        const materialized = fetched === null ? null : await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "name: plurnk");
        assert.equal(fetched?.mimetype, "application/yaml");
    });
});

test("text acquisition uses Fetch UTF-8 decoding and retains charset as metadata", async () => {
    const windows1252 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    await withFetch((async () => resp(windows1252, 200, {
        "content-type": "text/plain; charset=windows-1252",
    })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        const materialized = fetched === null ? null : await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "caf\uFFFD");
        assert.equal(fetched?.mimetype, "text/plain");
        assert.match(fetched?.header ?? "", /^content-type: text\/plain; charset=windows-1252$/m);
    });
});

test("an unsupported charset does not invent a non-Fetch decoder", async () => {
    await withFetch((async () => resp("Unicode stays Unicode", 200, {
        "content-type": "text/plain; charset=not-a-real-encoding",
    })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        const materialized = fetched === null ? null : await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "Unicode stays Unicode");
        assert.equal(fetched?.mimetype, "text/plain");
    });
});

test("GitHub blob acquisition uses one source target for byte fetch", async (t) => {
    t.mock.method(Guard, "isPublicUrl", async () => true);
    const seen: string[] = [];
    const blob = "https://github.com/nodejs/node/blob/main/src/node_version.h";
    const raw = "https://raw.githubusercontent.com/nodejs/node/main/src/node_version.h";
    await withFetch((async (url) => {
        seen.push(String(url));
        return resp("/* content */", 200, { "content-type": "text/plain" });
    }) as typeof fetch, async () => {
        await new WebFetcher().fetch(blob);
    });
    assert.deepEqual(seen, [raw]);
});

test("HTML → byte response materializes local floor projection when no materializer is selected", async () => {
    const projection = projectionCaps({
        async readable(content, mimetype) {
            return {
                content: "# Local Projected Floor",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "html-floor-v1",
            };
        },
    });
    await withFetch((async () => resp("<html><body><h1>Title</h1></body></html>", 200, { "content-type": "text/html; charset=utf-8" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.equal(fetched.body, "<html><body><h1>Title</h1></body></html>");
        assert.equal(fetched.mimetype, "text/html");
        const materialized = await WebFetcher.materialize(fetched, projection);
        assert.equal(materialized?.body?.content, "# Local Projected Floor");
        assert.equal(materialized?.html?.content, "<html><body><h1>Title</h1></body></html>");
        assert.match(
            materialized?.header ?? "",
            new RegExp(`^${MATERIALIZER_ID_HEADER}: local-projection:v1:unconfigured$`, "m"),
        );
    });
});

test("HTML → materializes the configured materializer's Markdown ({§http-materializer-plugins})", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => ({
            outcome: "success",
            body: "# Stub Extracted Page",
            identity: "stub-extract:v1",
            evidence: [
                { name: "x-plurnk-stub-request-id", value: "req-777" },
                { name: "x-plurnk-stub-credits", value: "0.2" },
            ],
        }),
    });
    const projection = projectionCaps({
        async readable() {
            return { content: "local floor", mimetype: "text/markdown", sourceMimetype: "text/html", projectionIdentity: "floor" };
        },
    });
    await withFetch((async () =>
        resp("<html><body>Original</body></html>", 200, { "content-type": "text/html" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        const materialized = await WebFetcher.materialize(fetched, projection);
        assert.equal(materialized?.body?.content, "# Stub Extracted Page");
        assert.equal(materialized?.body?.mimetype, "text/markdown");
        assert.equal(materialized?.html?.content, "<html><body>Original</body></html>");
        assert.match(materialized?.header ?? "", /x-plurnk-materializer-id: stub-extract:v1/);
        assert.match(materialized?.header ?? "", /x-plurnk-stub-request-id: req-777/);
        assert.match(materialized?.header ?? "", /x-plurnk-stub-credits: 0\.2/);
    });
});

test("supplied HTML never consults the materializer", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void; calls: unknown[] } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => {
            throw new Error("supplied content must not spend or refetch");
        },
    });
    const projection = projectionCaps({
        async readable(_content, mimetype) {
            return {
                content: "local supplied content",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "supplied-v1",
            };
        },
    });
    let calls = 0;
    await withFetch((async () => {
        calls += 1;
        throw new Error("supplied content must not spend or refetch");
    }) as typeof fetch, async () => {
        const materialized = await WebFetcher.materialize({
            url: PUB,
            body: "<html><body>Supplied</body></html>",
            mimetype: "text/html",
            header: "HTTP 200 OK",
            allowConfiguredMaterializer: false,
        }, projection);
        assert.equal(materialized?.body?.content, "local supplied content");
        assert.match(materialized?.header ?? "", /x-plurnk-materializer-id: local-projection:v1:ineligible/);
    });
    assert.equal(calls, 0);
    assert.equal(__stub.calls.length, 0, "the materializer was never consulted");
});

test("a recoverable materializer outcome uses an identified local floor", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => ({
            outcome: "recoverable",
            reason: "provider unavailable",
            identity: "stub-extract:v1",
            evidence: [
                { name: "x-plurnk-stub-request-id", value: "req-fallback" },
                { name: "x-plurnk-stub-credits", value: "0.4" },
            ],
        }),
    });
    const projection = projectionCaps({
        async readable(_content, mimetype) {
            return {
                content: "local fallback",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "floor-v1",
            };
        },
    });
    await withFetch((async () => resp("<html><body>Origin</body></html>", 200, {
        "content-type": "text/html",
    })) as typeof fetch, async () => {
        const materialized = await WebFetcher.materialize({
            url: PUB,
            body: "<html><body>Origin</body></html>",
            mimetype: "text/html",
            header: "HTTP 200 OK",
            allowConfiguredMaterializer: true,
        }, projection);
        assert.equal(materialized?.body?.content, "local fallback");
        assert.equal(materialized?.bodyOutcome.status, 203);
        assert.match(
            materialized?.header ?? "",
            /x-plurnk-materializer-id: local-fallback:stub-extract:v1/,
        );
        assert.match(materialized?.header ?? "", /x-plurnk-stub-request-id: req-fallback/);
        assert.match(materialized?.header ?? "", /x-plurnk-stub-credits: 0\.4/);
        assert.match(materialized?.header ?? "", /x-plurnk-projection-id: floor-v1/);
    });
});

test("a hard materializer failure preserves HTML but does not bless a local body", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => ({
            outcome: "hard",
            identity: "stub-extract:v1",
            evidence: [{ name: "x-plurnk-stub-reason", value: "authentication" }],
            problem: {
                status: 502,
                code: "stub-authentication-failed",
                detail: "The stub rejected the configured credentials.",
                retryable: false,
            },
        }),
    });
    let projectionCalls = 0;
    const projection = projectionCaps({
        async readable() {
            projectionCalls += 1;
            return { content: "must not publish", mimetype: "text/markdown", sourceMimetype: "text/html", projectionIdentity: "floor" };
        },
    });
    await withFetch((async () => resp("<html><body>Origin</body></html>", 200, {
        "content-type": "text/html",
    })) as typeof fetch, async () => {
        const materialized = await WebFetcher.materialize({
            url: PUB,
            body: "<html><body>Origin</body></html>",
            mimetype: "text/html",
            header: "HTTP 200 OK",
            allowConfiguredMaterializer: true,
        }, projection);
        assert.equal(materialized?.body, undefined);
        assert.equal(materialized?.html?.content, "<html><body>Origin</body></html>");
        assert.equal(materialized?.bodyOutcome.failure?.code, "stub-authentication-failed");
        assert.equal(materialized?.htmlOutcome?.status, 200);
        assert.match(materialized?.header ?? "", new RegExp(`^x-plurnk-stub-reason: authentication$`, "m"));
    });
    assert.equal(projectionCalls, 0);
});

test("a materializer extraction throw surfaces as the scheme failure, not a silent fallback", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => { throw new Error("stub exploded"); },
    });
    await withFetch((async () => resp("<html><body>Origin</body></html>", 200, {
        "content-type": "text/html",
    })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        await assert.rejects(
            WebFetcher.materialize(fetched, PROJECTION),
            /stub exploded/,
            "the plugin's throw is the materialization failure",
        );
    });
});

test("the materializer may produce the body after admitted origin transport failure while HTML stays failed", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => ({
            outcome: "success",
            body: "# Provider-only body",
            identity: "stub-extract:v1",
            evidence: [],
        }),
    });
    await withFetch((async () => resp("<html>unused</html>", 200, {
        "content-type": "text/html",
    })) as typeof fetch, async () => {
        const materialized = await WebFetcher.materialize(
            WebFetcher.unavailable(PUB, new Error("origin reset"), true),
            PROJECTION,
        );
        assert.equal(materialized?.body?.content, "# Provider-only body");
        assert.equal(materialized?.bodyOutcome.status, 200);
        assert.equal(materialized?.html, undefined);
        assert.equal(materialized?.htmlOutcome?.failure?.code, "html-unavailable");
        assert.match(materialized?.header ?? "", /x-plurnk-origin-error: origin reset/);
    });
});

test("origin Markdown is authoritative, negotiates one HTML variant, and never consults the materializer", async () => {
    process.env[MATERIALIZER_ENV] = "stub";
    const { __stub } = (await import(pathToFileURL(resolve(STUB_DIR, "materializer.js")).href)) as unknown as { __stub: { set: (b: unknown) => void; calls: unknown[] } };
    __stub.set({
        eligible: () => "stub-extract:v1",
        extract: async () => { throw new Error("origin Markdown must bypass the materializer"); },
    });
    const calls: Array<{ url: string; accept: string }> = [];
    await withFetch((async (input, init) => {
        const accept = new Headers(init?.headers).get("accept") ?? "";
        calls.push({ url: String(input), accept });
        return accept === "text/html"
            ? resp("<html><body>Source</body></html>", 200, { "content-type": "text/html" })
            : resp("# Origin Markdown", 200, { "content-type": "text/markdown", vary: "Accept" });
    }) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.equal(fetched.body, "# Origin Markdown");
        const materialized = await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "# Origin Markdown");
        assert.equal(materialized?.html?.content, "<html><body>Source</body></html>");
        assert.match(materialized?.header ?? "", /x-plurnk-materializer-id: origin-markdown:v1/);
        assert.equal(materialized?.bodyOutcome.status, 200);
        assert.equal(materialized?.htmlOutcome?.status, 200);
    });
    assert.deepEqual(calls.map(({ accept }) => accept), [MARKDOWN_ACCEPT, "text/html"]);
    assert.equal(__stub.calls.length, 0, "origin Markdown never consults the materializer");
});

test("an authored Accept value is honored exactly", async () => {
    let observed = "";
    await withFetch((async (_input, init) => {
        observed = new Headers(init?.headers).get("accept") ?? "";
        return resp('{"ok":true}', 200, { "content-type": "application/json" });
    }) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB, {
            headers: [["Accept", "application/json"]],
        });
        assert.equal(fetched?.mimetype, "application/json");
    });
    assert.equal(observed, "application/json");
});

test("an authored Markdown Accept does not authorize a package-generated HTML variant request", async () => {
    const observed: string[] = [];
    await withFetch((async (_input, init) => {
        observed.push(new Headers(init?.headers).get("accept") ?? "");
        return resp("# Authored representation", 200, { "content-type": "text/markdown" });
    }) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB, {
            headers: [["Accept", "text/markdown"]],
        });
        assert.ok(fetched !== null);
        const materialized = await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "# Authored representation");
        assert.equal(materialized?.html, undefined);
        assert.equal(materialized?.htmlOutcome?.failure?.code, "html-variant-unavailable");
    });
    assert.deepEqual(observed, ["text/markdown"]);
});

test("materialization preserves a projection exception and identifies its stage", async () => {
    const cause = new Error("reader implementation failed");
    const projection = projectionCaps({
        async readable() {
            throw cause;
        },
    });
    await assert.rejects(
        WebFetcher.materialize({ url: PUB, body: "<html></html>", mimetype: "text/html" }, projection),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.cause, cause);
            assert.equal((err as Error & { stage?: string }).stage, "projection");
            return true;
        },
    );
});

test("caller cancellation during origin acquisition rejects with the exact caller reason", async (t) => {
    const caller = new AbortController();
    const reason = new Error("operator cancelled");
    t.mock.method(Guard, "fetch", async (
        _url: Parameters<typeof Guard.fetch>[0],
        _init: Parameters<typeof Guard.fetch>[1],
        signal: Parameters<typeof Guard.fetch>[2],
    ) => {
        caller.abort(reason);
        signal.throwIfAborted();
        throw new Error("unreachable after abort");
    });
    await assert.rejects(
        new WebFetcher().fetch(PUB, { signal: caller.signal }),
        (error: unknown) => error === reason,
    );
});

test("a pre-aborted caller rejects before the automatic URL check", async (t) => {
    const caller = new AbortController();
    const reason = new Error("already cancelled");
    caller.abort(reason);
    const guarded = t.mock.method(Guard, "fetch");
    await assert.rejects(
        new WebFetcher().fetch(PUB, { signal: caller.signal }),
        (error: unknown) => error === reason,
    );
    assert.equal(guarded.mock.callCount(), 0);
});

test("automatic URL check refusal → null, and never fetches", async () => {
    let called = false;
    await withFetch((async () => { called = true; return resp("x", 200); }) as typeof fetch, async () => {
        assert.equal(await new WebFetcher().fetch("http://169.254.169.254/latest/meta-data/"), null);
    });
    assert.equal(called, false);
});

test("non-2xx → null", async () => {
    await withFetch((async () => resp("nope", 404, { "content-type": "text/html" })) as typeof fetch, async () => {
        assert.equal(await new WebFetcher().fetch(PUB), null);
    });
});

test("handler-declared binary bytes reach one readable projection without a durable byte lane", async () => {
    const projection = projectionCaps({
        async isBinary(mimetype) { return mimetype === "text/x-binary"; },
        async readableBytes(chunks, mimetype) {
            const bytes: number[] = [];
            for await (const chunk of chunks) bytes.push(...chunk);
            return {
                content: `projected:${bytes.join(",")}`,
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "binary-reader-v1",
            };
        },
    });
    await withFetch((async () => resp(Uint8Array.of(1, 2, 3), 200, {
        "content-type": "text/x-binary",
    })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.notEqual(typeof fetched.body, "string", "registry-declared binary input remains bytes");
        assert.match(fetched.header ?? "", /^content-type: text\/x-binary$/m);
        const materialized = await WebFetcher.materialize(fetched, projection);
        assert.deepEqual(materialized, {
            body: { content: "projected:1,2,3", mimetype: "text/markdown" },
            header: `${fetched.header}\nx-plurnk-projection-id: binary-reader-v1`,
            bodyOutcome: { status: 200 },
            projection: {
                sourceMimetype: "text/x-binary",
                identity: "binary-reader-v1",
            },
        });
    });
});

test("binary materialization cancels unread response bytes after a projection returns", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); },
        cancel() { cancelled = true; },
    });
    const projection = projectionCaps({
        async isBinary() { return true; },
        async readableBytes(_chunks, mimetype) {
            return {
                content: "projected without reading",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "non-consuming-reader",
            };
        },
    });
    await withFetch(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "text/x-binary" },
    }), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.equal((await WebFetcher.materialize(fetched, projection))?.body?.content, "projected without reading");
    });
    assert.equal(cancelled, true);
});

test("registry classification failure cancels the owned response body and preserves its cause", async () => {
    const cause = new Error("registry unavailable");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); },
        cancel() { cancelled = true; },
    });
    const projection = projectionCaps({ async isBinary() { throw cause; } });
    await withFetch(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "text/x-binary" },
    }), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        await assert.rejects(
            WebFetcher.materialize(fetched, projection),
            (error: unknown) => error instanceof WebMaterializationError && error.cause === cause,
        );
    });
    assert.equal(cancelled, true);
});

test("empty textual body remains a present representation", async () => {
    await withFetch((async () => resp("", 200, { "content-type": "text/plain" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.deepEqual(await WebFetcher.materialize(fetched, PROJECTION), {
            body: { content: "", mimetype: "text/plain" },
            header: fetched.header,
            bodyOutcome: { status: 200 },
        });
    });
});

test("network error → null (unreachable is dead, not a throw)", async () => {
    await withFetch((async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch, async () => {
        assert.equal(await new WebFetcher().fetch(PUB), null);
    });
});
