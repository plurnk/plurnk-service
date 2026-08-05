// WebFetcher contract coverage {§prefetch}. Hermetic: injected fake browser, mocked
// global fetch, and IP literals or explicit guard mocks (no DNS). Env from
// --env-file=.env.defaults.

import test from "node:test";
import { strict as assert } from "node:assert";
import Guard from "./Guard.ts";
import WebFetcher, { WebMaterializationError } from "./WebFetcher.ts";
import type { RenderResult } from "./Browser.ts";
import { MimetypeClassifier, type ProjectionCaps } from "@plurnk/plurnk-schemes";

const PUB = "https://93.184.216.34/x"; // public IP literal — skips DNS

const projectionCaps = (overrides: Partial<ProjectionCaps> = {}): ProjectionCaps => ({
    async readable() { return null; },
    async readableBytes() { return null; },
    async identity(mimetype) { return `${mimetype}-projection`; },
    async isBinary(mimetype) { return MimetypeClassifier.isBinary(mimetype); },
    ...overrides,
});
const PROJECTION = projectionCaps();

const fakeBrowser = (html: string) => {
    const calls: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    return {
        calls,
        render: async (url: string, opts: { workerId: number; signal?: AbortSignal; headers?: ReadonlyArray<readonly [string, string]> }): Promise<RenderResult> => {
            calls.push({ url, signal: opts.signal });
            return { status: 200, statusText: "OK", headers: [["content-type", "text/html"]], html };
        },
    };
};

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
        assert.equal(materialized?.body.content, '{"a":1}');
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
        assert.equal(materialized?.body.content, "name: plurnk");
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
        assert.equal(materialized?.body.content, "caf�");
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
        assert.equal(materialized?.body.content, "Unicode stays Unicode");
        assert.equal(fetched?.mimetype, "text/plain");
    });
});

test("GitHub blob acquisition uses one source target for byte fetch and render", async (t) => {
    t.mock.method(Guard, "isPublicUrl", async () => true);
    const browser = fakeBrowser("<html><body>rendered source</body></html>");
    const seen: string[] = [];
    const blob = "https://github.com/nodejs/node/blob/main/src/node_version.h";
    const raw = "https://raw.githubusercontent.com/nodejs/node/main/src/node_version.h";
    await withFetch((async (url) => {
        seen.push(String(url));
        return resp("<html></html>", 200, { "content-type": "text/html" });
    }) as typeof fetch, async () => {
        const fetched = await new WebFetcher(browser).fetch(blob);
        await fetched?.render?.();
    });
    assert.deepEqual(seen, [raw]);
    assert.equal(browser.calls[0]?.url, raw);
});

test("HTML → guarded byte response first; ordinary browser render is a lazy fallback", async () => {
    const b = fakeBrowser("<html><body>rendered</body></html>");
    await withFetch((async () => resp("<html></html>", 200, { "content-type": "text/html; charset=utf-8" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher(b).fetch(PUB);
        assert.equal(fetched?.body, "<html></html>");
        assert.equal(fetched?.mimetype, "text/html");
        assert.equal(b.calls.length, 0, "a valid byte response does not launch the browser eagerly");
        assert.deepEqual(await fetched?.render?.(), { body: "<html><body>rendered</body></html>", mimetype: "text/html" });
    });
    assert.equal(b.calls[0].signal, undefined,
        "the byte-probe timeout does not close render at its salvage deadline");
});

test("materialization accepts an honest empty XHTML projection without rendering", async () => {
    let renders = 0;
    const projection = projectionCaps({
        async readable(_content, mimetype) {
            return {
                content: "",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "empty-xhtml-projection",
            };
        },
    });
    const result = await WebFetcher.materialize({
        body: "<html><body></body></html>",
        mimetype: "application/xhtml+xml",
        render: async () => {
            renders += 1;
            return { body: "<p>wrong fallback</p>", mimetype: "text/html" };
        },
    }, projection);
    assert.deepEqual(result, {
        body: { content: "", mimetype: "text/markdown" },
        html: { content: "<html><body></body></html>", mimetype: "application/xhtml+xml" },
        projection: {
            sourceMimetype: "application/xhtml+xml",
            identity: "empty-xhtml-projection",
        },
    });
    assert.equal(renders, 0);
});

test("materialization preserves a projection exception and identifies its stage", async () => {
    const cause = new Error("reader implementation failed");
    const projection = projectionCaps({
        async readable() {
            throw cause;
        },
    });
    await assert.rejects(
        WebFetcher.materialize({ body: "<html></html>", mimetype: "text/html" }, projection),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.cause, cause);
            assert.equal((err as Error & { stage?: string }).stage, "projection");
            return true;
        },
    );
});

test("materialization preserves a lazy-render exception and identifies its stage", async () => {
    const cause = new Error("browser navigation failed");
    const projection = projectionCaps({ async readable() { return null; } });
    await assert.rejects(
        WebFetcher.materialize({
            body: "<html></html>",
            mimetype: "text/html",
            render: async () => { throw cause; },
        }, projection),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.cause, cause);
            assert.equal((err as Error & { stage?: string }).stage, "render");
            return true;
        },
    );
});

test("caller cancellation spans both byte probe and lazy render", async () => {
    const b = fakeBrowser("<html><body>rendered</body></html>");
    const caller = new AbortController();
    await withFetch((async () => resp("<html></html>", 200, { "content-type": "text/html" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher(b).fetch(PUB, { signal: caller.signal });
        await fetched?.render?.();
    });
    assert.equal(b.calls[0].signal, caller.signal);
});

test("caller cancellation during the byte probe rejects with the exact caller reason", async (t) => {
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

test("the independent byte-probe timeout remains an ordinary dead result", async (t) => {
    const prior = process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT;
    process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT = "1";
    const caller = new AbortController();
    t.mock.method(Guard, "fetch", async (
        _url: Parameters<typeof Guard.fetch>[0],
        _init: Parameters<typeof Guard.fetch>[1],
        signal: Parameters<typeof Guard.fetch>[2],
    ) => await new Promise<Response>((_resolve, reject) => {
        const rejectTimedOut = () => {
            const timeoutReason = signal.reason;
            caller.abort(new Error("later caller cancellation"));
            reject(timeoutReason);
        };
        if (signal.aborted) rejectTimedOut();
        else signal.addEventListener("abort", rejectTimedOut, { once: true });
    }));
    try {
        assert.equal(await new WebFetcher().fetch(PUB, { signal: caller.signal }), null);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT;
        else process.env.PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT = prior;
    }
});

test("close releases the owned renderer", async () => {
    let closed = 0;
    const fetcher = new WebFetcher({
        render: async (): Promise<RenderResult> => ({
            status: 200, statusText: "OK", headers: [], html: "<html></html>",
        }),
        close: async () => { closed += 1; },
    });
    await fetcher.close();
    assert.equal(closed, 1);
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
        assert.equal(await new WebFetcher(fakeBrowser("x")).fetch(PUB), null);
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
        assert.equal((await WebFetcher.materialize(fetched, projection))?.body.content, "projected without reading");
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

test("an unparseable Content-Type reaches binary projection and is pruned when absent", async () => {
    await withFetch((async () => resp("not trustworthy", 200, {
        "content-type": "text/plain garbage",
    })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.notEqual(typeof fetched.body, "string");
        assert.equal(await WebFetcher.materialize(fetched, PROJECTION), null);
    });
});

test("empty textual body → null", async () => {
    await withFetch((async () => resp("", 200, { "content-type": "text/plain" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.ok(fetched !== null);
        assert.equal(await WebFetcher.materialize(fetched, PROJECTION), null);
    });
});

test("render yielding empty DOM → null", async () => {
    await withFetch((async () => resp("<html></html>", 200, { "content-type": "text/html" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher(fakeBrowser("")).fetch(PUB);
        assert.equal(await fetched?.render?.(), null);
    });
});

test("lazy rendering preserves a browser exception instead of converting it to absence", async () => {
    const cause = new Error("chromium crashed");
    const browser = {
        async render(): Promise<RenderResult> {
            throw cause;
        },
    };
    await withFetch((async () => resp("<html></html>", 200, { "content-type": "text/html" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher(browser).fetch(PUB);
        assert.ok(fetched?.render !== undefined);
        await assert.rejects(fetched.render(), (err: unknown) => err === cause);
    });
});

test("network error → null (unreachable is dead, not a throw)", async () => {
    await withFetch((async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch, async () => {
        assert.equal(await new WebFetcher().fetch(PUB), null);
    });
});
