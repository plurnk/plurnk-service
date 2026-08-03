// WebFetcher contract coverage {§prefetch}. Hermetic: injected fake browser, mocked
// global fetch, and IP literals or explicit guard mocks (no DNS). Env from
// --env-file=.env.defaults.

import test from "node:test";
import { strict as assert } from "node:assert";
import Guard from "./Guard.ts";
import WebFetcher from "./WebFetcher.ts";
import type { RenderResult } from "./Browser.ts";

const PUB = "https://93.184.216.34/x"; // public IP literal — skips DNS

const fakeBrowser = (html: string) => {
    const calls: Array<{ url: string; guarded: boolean; signal: AbortSignal | undefined }> = [];
    return {
        calls,
        render: async (url: string, opts: { workerId: number; signal?: AbortSignal; headers?: ReadonlyArray<readonly [string, string]>; guard?: (u: string) => Promise<boolean> }): Promise<RenderResult> => {
            calls.push({ url, guarded: typeof opts.guard === "function", signal: opts.signal });
            return { status: 200, statusText: "OK", headers: [["content-type", "text/html"]], html };
        },
    };
};

const withFetch = async (impl: typeof fetch, fn: () => Promise<void>) => {
    const orig = globalThis.fetch;
    globalThis.fetch = impl;
    try { await fn(); } finally { globalThis.fetch = orig; }
};
const resp = (body: string | null, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers });

test("live public textual URL → { body, mimetype }", async () => {
    await withFetch((async () => resp('{"a":1}', 200, { "content-type": "application/json" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher().fetch(PUB);
        assert.equal(fetched?.body, '{"a":1}');
        assert.equal(fetched?.mimetype, "application/json");
        assert.match(fetched?.header ?? "", /^HTTP 200 /);
        assert.match(fetched?.header ?? "", /^x-plurnk-request-method: GET$/m);
        assert.match(fetched?.header ?? "", /^x-plurnk-fetched-at:/m);
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

test("HTML → byte response first; guarded browser render is a lazy fallback", async () => {
    const b = fakeBrowser("<html><body>rendered</body></html>");
    await withFetch((async () => resp("<html></html>", 200, { "content-type": "text/html; charset=utf-8" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher(b).fetch(PUB);
        assert.equal(fetched?.body, "<html></html>");
        assert.equal(fetched?.mimetype, "text/html");
        assert.equal(b.calls.length, 0, "a valid byte response does not launch the browser eagerly");
        assert.deepEqual(await fetched?.render?.(), { body: "<html><body>rendered</body></html>", mimetype: "text/html" });
    });
    assert.equal(b.calls[0].guarded, true);
    assert.equal(b.calls[0].signal, undefined,
        "the byte-probe timeout does not close render at its salvage deadline");
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

test("SSRF-refused target → null, and never fetches", async () => {
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

test("non-textual (binary) → null (pruned)", async () => {
    await withFetch((async () => resp("PNGDATA", 200, { "content-type": "image/png" })) as typeof fetch, async () => {
        assert.equal(await new WebFetcher().fetch(PUB), null);
    });
});

test("empty textual body → null", async () => {
    await withFetch((async () => resp("", 200, { "content-type": "text/plain" })) as typeof fetch, async () => {
        assert.equal(await new WebFetcher().fetch(PUB), null);
    });
});

test("render yielding empty DOM → null", async () => {
    await withFetch((async () => resp("<html></html>", 200, { "content-type": "text/html" })) as typeof fetch, async () => {
        const fetched = await new WebFetcher(fakeBrowser("")).fetch(PUB);
        assert.equal(await fetched?.render?.(), null);
    });
});

test("network error → null (unreachable is dead, not a throw)", async () => {
    await withFetch((async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch, async () => {
        assert.equal(await new WebFetcher().fetch(PUB), null);
    });
});
