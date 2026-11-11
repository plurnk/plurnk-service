// WebFetcher contract coverage {§prefetch}. Hermetic: mocked global fetch,
// and IP literals or explicit guard mocks (no DNS). Env from --env-file=.env.defaults.

import test from "node:test";
import { buffer } from "node:stream/consumers";
import { strict as assert } from "node:assert";
import Guard from "./Guard.ts";
import WebFetcher, {
    MARKDOWN_ACCEPT,
    WebMaterializationError,
} from "./WebFetcher.ts";
import { MimetypeClassifier, type ProjectionCaps } from "@plurnk/plurnk-schemes";
import { requestUrl } from "../../scripts/lib/test-fetch.ts";

const PUB = "https://93.184.216.34/x";

const projectionCaps = (overrides: Partial<ProjectionCaps> = {}): ProjectionCaps => ({
    async readable() { return null; },
    async binary(chunks, mimetype) {
        return { bytes: await buffer(chunks), readable: null, projectionIdentity: `${mimetype}-projection` };
    },
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

test("{§prefetch} live public textual URL → { body, mimetype }", async () => {
    await withFetch((async () => resp('{"a":1}', 200, { "content-type": "application/json" })), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        const materialized = fetched === null ? null : await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, '{\n  "a": 1\n}');
        assert.equal(fetched?.mimetype, "application/json");
        assert.match(fetched?.header ?? "", /^HTTP 200 /);
        assert.match(fetched?.header ?? "", /^x-plurnk-request-method: GET$/m);
        assert.match(fetched?.header ?? "", /^x-plurnk-fetched-at:/m);
    });
});

test("{§prefetch} finite JSON presentation preserves literal values and non-JSON source layout", async () => {
    const input = '{"id":9007199254740993,"nested":{"ok":true}}';
    for (const mimetype of ["application/json", "application/problem+json"]) {
        const materialized = await WebFetcher.materialize({ url: PUB, body: input, mimetype }, PROJECTION);
        assert.equal(materialized?.body?.content, '{\n  "id": 9007199254740993,\n  "nested": {\n    "ok": true\n  }\n}');
        assert.equal(materialized?.body?.mimetype, mimetype);
    }
    for (const [body, mimetype] of [
        [input, "text/plain"],
        ['{"partial":', "application/json"],
        ['{"a":1}\n{"b":2}', "application/x-ndjson"],
    ]) {
        const materialized = await WebFetcher.materialize({ url: PUB, body, mimetype }, PROJECTION);
        assert.equal(materialized?.body?.content, body);
    }
});

test("{§prefetch} the shared textual taxonomy accepts application/yaml", async () => {
    await withFetch((async () => resp("name: plurnk", 200, { "content-type": "application/yaml" })), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        const materialized = fetched === null ? null : await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "name: plurnk");
        assert.equal(fetched?.mimetype, "application/yaml");
    });
});

test("{§prefetch} text acquisition uses Fetch UTF-8 decoding and retains charset as metadata", async () => {
    const windows1252 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    await withFetch((async () => resp(windows1252, 200, {
        "content-type": "text/plain; charset=windows-1252",
    })), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        const materialized = fetched === null ? null : await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "caf\uFFFD");
        assert.equal(fetched?.mimetype, "text/plain");
        assert.match(fetched?.header ?? "", /^content-type: text\/plain; charset=windows-1252$/m);
    });
});

test("{§prefetch} an unsupported charset does not invent a non-Fetch decoder", async () => {
    await withFetch((async () => resp("Unicode stays Unicode", 200, {
        "content-type": "text/plain; charset=not-a-real-encoding",
    })), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        const materialized = fetched === null ? null : await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "Unicode stays Unicode");
        assert.equal(fetched?.mimetype, "text/plain");
    });
});

test("{§prefetch} GitHub blob acquisition uses one source target for byte fetch", async (t) => {
    t.mock.method(Guard, "isPublicUrl", async () => true);
    const seen: string[] = [];
    const blob = "https://github.com/nodejs/node/blob/main/src/node_version.h";
    const raw = "https://raw.githubusercontent.com/nodejs/node/main/src/node_version.h";
    await withFetch((async (url) => {
        seen.push(requestUrl(url));
        return resp("/* content */", 200, { "content-type": "text/plain" });
    }), async () => {
        await new WebFetcher().fetch(blob);
    });
    assert.deepEqual(seen, [raw]);
});

test("{§prefetch} HTML → byte response materializes local projection", async () => {
    const projection = projectionCaps({
        async readable(_content, mimetype) {
            return {
                content: "# Local Projected Floor",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "html-floor-v1",
            };
        },
    });
    await withFetch((async () => resp("<html><body><h1>Title</h1></body></html>", 200, { "content-type": "text/html; charset=utf-8" })), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.equal(fetched.body, "<html><body><h1>Title</h1></body></html>");
        assert.equal(fetched.mimetype, "text/html");
        const materialized = await WebFetcher.materialize(fetched, projection);
        assert.equal(materialized?.readable?.content, "# Local Projected Floor");
        assert.equal(materialized?.body?.content, "<html><body><h1>Title</h1></body></html>");
        assert.match(materialized?.header ?? "", /^x-plurnk-projection-id: html-floor-v1$/m);
    });
});

test("{§prefetch} supplied HTML projects locally without fetching", async () => {
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
        throw new Error("supplied content must not refetch");
    }), async () => {
        const materialized = await WebFetcher.materialize({
            url: PUB,
            body: "<html><body>Supplied</body></html>",
            mimetype: "text/html",
            header: "HTTP 200 OK",
        }, projection);
        assert.equal(materialized?.readable?.content, "local supplied content");
        assert.match(materialized?.header ?? "", /^x-plurnk-projection-id: supplied-v1$/m);
    });
    assert.equal(calls, 0);
});

test("{§channel-selection} origin transport unavailability marks both channels with the origin's failure", async () => {
    const materialized = await WebFetcher.materialize(
        WebFetcher.unavailable(PUB, new Error("origin reset")),
        PROJECTION,
    );
    assert.equal(materialized?.readable, undefined);
    assert.deepEqual(materialized?.body, { content: "", mimetype: "text/html" });
    // {§channel-selection} — the source channel's failure is the origin's own, not a generic one.
    assert.equal(materialized?.bodyOutcome?.failure?.code, "fetch-failed");
    assert.equal(materialized?.readableOutcome?.failure?.code, "fetch-failed");
    assert.match(materialized?.header ?? "", /x-plurnk-origin-error: origin reset/);
});

test("{§channel-selection} origin Markdown is the source itself: one request, no variant, no projection", async () => {
    const calls: Array<{ url: string; accept: string }> = [];
    await withFetch((async (input, init) => {
        const accept = new Headers(init?.headers).get("accept") ?? "";
        calls.push({ url: requestUrl(input), accept });
        return resp("# Origin Markdown", 200, { "content-type": "text/markdown", vary: "Accept" });
    }), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.equal(fetched.body, "# Origin Markdown");
        const materialized = await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "# Origin Markdown");
        assert.equal(materialized?.readable, undefined, "{§channel-selection}: readable text needs no projection and no HTML variant");
        assert.equal(materialized?.readableOutcome, undefined);
        assert.equal(materialized?.bodyOutcome.status, 200);
    });
    assert.deepEqual(calls.map(({ accept }) => accept), [MARKDOWN_ACCEPT], "exactly one request");
});

test("{§prefetch} an authored Accept value is honored exactly", async () => {
    let observed = "";
    await withFetch((async (_input, init) => {
        observed = new Headers(init?.headers).get("accept") ?? "";
        return resp('{"ok":true}', 200, { "content-type": "application/json" });
    }), async () => {
        const fetched = await new WebFetcher().fetch(PUB, {
            headers: [["Accept", "application/json"]],
        });
        assert.equal(fetched?.mimetype, "application/json");
    });
    assert.equal(observed, "application/json");
});

test("{§prefetch} an authored Markdown Accept is honored and yields the Markdown as the body", async () => {
    const observed: string[] = [];
    await withFetch((async (_input, init) => {
        observed.push(new Headers(init?.headers).get("accept") ?? "");
        return resp("# Authored representation", 200, { "content-type": "text/markdown" });
    }), async () => {
        const fetched = await new WebFetcher().fetch(PUB, {
            headers: [["Accept", "text/markdown"]],
        });
        assert.ok(fetched !== null);
        const materialized = await WebFetcher.materialize(fetched, PROJECTION);
        assert.equal(materialized?.body?.content, "# Authored representation");
        assert.equal(materialized?.readable, undefined);
        assert.equal(materialized?.readableOutcome, undefined);
    });
    assert.deepEqual(observed, ["text/markdown"]);
});

test("{§prefetch} materialization preserves a projection exception and identifies its stage", async () => {
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

test("{§prefetch} caller cancellation during origin acquisition rejects with the exact caller reason", async (t) => {
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

test("{§prefetch} a pre-aborted caller rejects before the automatic URL check", async (t) => {
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

test("{§prefetch} automatic URL check refusal → null, and never fetches", async () => {
    let called = false;
    await withFetch((async () => { called = true; return resp("x", 200); }), async () => {
        assert.equal(await new WebFetcher().fetch("http://169.254.169.254/latest/meta-data/"), null);
    });
    assert.equal(called, false);
});

test("{§prefetch} non-2xx → null", async () => {
    await withFetch((async () => resp("nope", 404, { "content-type": "text/html" })), async () => {
        assert.equal(await new WebFetcher().fetch(PUB), null);
    });
});

test("{§prefetch} handler-declared binary bytes retain their source beside the readable projection", async () => {
    const projection = projectionCaps({
        async isBinary(mimetype) { return mimetype === "text/x-binary"; },
        async binary(chunks, mimetype) {
            const bytes: number[] = [];
            for await (const chunk of chunks) bytes.push(...chunk);
            return { bytes: Uint8Array.from(bytes), projectionIdentity: "binary-reader-v1", readable: {
                content: `projected:${bytes.join(",")}`,
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "binary-reader-v1",
            } };
        },
    });
    await withFetch((async () => resp(Uint8Array.of(1, 2, 3), 200, {
        "content-type": "text/x-binary",
    })), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.notEqual(typeof fetched.body, "string", "registry-declared binary input remains bytes");
        assert.match(fetched.header ?? "", /^content-type: text\/x-binary$/m);
        const materialized = await WebFetcher.materialize(fetched, projection);
        assert.deepEqual(materialized, {
            body: { content: "", bytes: Uint8Array.of(1, 2, 3), mimetype: "text/x-binary" },
            readable: { content: "projected:1,2,3", mimetype: "text/markdown" },
            header: `${fetched.header}\nx-plurnk-projection-id: binary-reader-v1`,
            bodyOutcome: { status: 200 },
            readableOutcome: { status: 200 },
            projection: {
                sourceMimetype: "text/x-binary",
                identity: "binary-reader-v1",
            },
        });
    });
});

test("{§prefetch} binary materialization cancels unread response bytes after a projection returns", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); },
        cancel() { cancelled = true; },
    });
    const projection = projectionCaps({
        async isBinary() { return true; },
        async binary(_chunks, mimetype) {
            return { bytes: new Uint8Array(), projectionIdentity: "non-consuming-reader", readable: {
                content: "projected without reading",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "non-consuming-reader",
            } };
        },
    });
    await withFetch(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "text/x-binary" },
    }), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.equal((await WebFetcher.materialize(fetched, projection)).readable?.content, "projected without reading");
    });
    assert.equal(cancelled, true);
});

test("{§prefetch} registry classification failure cancels the owned response body and preserves its cause", async () => {
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

test("{§prefetch} empty textual body remains a present representation", async () => {
    await withFetch((async () => resp("", 200, { "content-type": "text/plain" })), async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.deepEqual(await WebFetcher.materialize(fetched, PROJECTION), {
            body: { content: "", mimetype: "text/plain" },
            header: fetched.header,
            bodyOutcome: { status: 200 },
        });
    });
});

test("{§prefetch} network error → null (unreachable is dead, not a throw)", async () => {
    await withFetch((async () => { throw new Error("ECONNREFUSED"); }), async () => {
        assert.equal(await new WebFetcher().fetch(PUB), null);
    });
});
