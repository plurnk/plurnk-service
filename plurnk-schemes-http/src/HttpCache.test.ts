import test from "node:test";
import { buffer } from "node:stream/consumers";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Http from "./Http.ts";
import { CACHE_VARIANT_HEADER, MATERIALIZER_ENV, MATERIALIZER_ID_HEADER } from "./WebFetcher.ts";
import {
    STUB_DIR,
    findStmt,
    makeCtx,
    mockFetch,
    prepareExactFind,
    prepareRepresentation,
    priorEntry,
    projectionCaps,
    readStmt,
    registerMaterializerStub,
    stampedHeader,
    urlTarget,
    withFetch,
    withTtl,
} from "../test/harness.ts";

registerMaterializerStub();

test("{§http-lifecycle} revalidation: a mutation response cannot satisfy a later GET", async () => {
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

test("{§http-lifecycle} exact FIND preparation reacquires an exact URL whose stored response came from a mutation", async () => {
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

test("{§http-lifecycle} exact FIND preparation reuses only a derived representation produced by the installed projection", async () => {
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
            async binary(_chunks, mimetype) {
                return { bytes: await buffer(_chunks), projectionIdentity: "pdf-reader-v2", readable: {
                    content: "current projection",
                    mimetype: "text/markdown",
                    sourceMimetype: mimetype,
                    projectionIdentity: "pdf-reader-v2",
                } };
            },
        });
        const { ctx, inspect } = makeCtx(
            priorEntry(Buffer.from([0]).toString("base64"), "application/pdf", header, "stored projection", "static"),
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
        assert.equal(inspect().wrote?.entry.channels.readable?.content, expectedFetch ? "current projection" : undefined);
        if (expectedFetch) assert.deepEqual(inspect().wrote?.entry.channels.body?.bytes, Buffer.from([1]));
        else assert.equal(inspect().storedEntry?.channels.body?.content, Buffer.from([0]).toString("base64"));
    }
});

test("{§http-lifecycle} stale materializer HTML-page materialization performs full reacquisition without origin validators", async () => {
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
        "<html>cached page</html>",
        "text/html",
        `${stampedHeader(500_000, '\ncontent-type: text/html\netag: "v1"')}\n${MATERIALIZER_ID_HEADER}: stub-extract:v1\nx-plurnk-stub-request-id: req-cached`,
        "cached page",
    ));
    let conditional = false;
    const probe = async (_input: string | URL | Request, init?: RequestInit) => {
        conditional = new Headers(init?.headers).has("if-none-match");
        return new Response("<html>fresh page</html>", {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/html", etag: '"v2"' },
        });
    };
    await withFetch(probe, async () => {
        const r = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        assert.equal(r.status, 200);
    });
    assert.equal(conditional, false);
    assert.equal(inspect().storedEntry?.channels.readable?.content, "fresh page");
    assert.equal(inspect().storedEntry?.channels.body?.content, "<html>fresh page</html>");
    const header = inspect().storedEntry?.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-materializer-id: stub-extract:v1$/m);
    assert.match(header, /^x-plurnk-stub-request-id: req-fresh$/m);
});

test("{§revalidation} TTL: enabling a materializer invalidates a locally materialized HTML body and its validators", async () => {
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
        "<html>old source</html>",
        "text/html",
        storedHeader,
        "old local body",
    ));
    let originFetched = false;
    let conditional = false;
    await withTtl("60000", async () => {
        await withFetch((async (_input, init) => {
            originFetched = true;
            conditional = new Headers(init?.headers).has("if-none-match");
            return new Response("<html>current source</html>", {
                status: 200,
                headers: { "content-type": "text/html", etag: '"current"' },
            });
        }), async () => {
            await prepareRepresentation(new Http(),
                readStmt(urlTarget("https://example.com/page", "/page")),
                ctx,
            );
        });
    });
    assert.equal(originFetched, true);
    assert.equal(conditional, false, "old validators cannot certify a different materializer route");
    assert.equal(inspect().storedEntry?.channels.readable?.content, "# Current stub body");
    assert.equal(inspect().storedEntry?.channels.body?.content, "<html>current source</html>");
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
        name: "a strong response ETag cannot promote a stored weak tag to byte identity",
        storedValidator: 'etag: W/"v1"',
        responseHeaders: { etag: '"v1"' },
        expectedConditional: ["if-none-match", 'W/"v1"'],
        valid: false,
    },
    {
        name: "the same weak ETag identifies the stored response",
        storedValidator: 'etag: W/"v1"',
        responseHeaders: { etag: 'W/"v1"' },
        expectedConditional: ["if-none-match", 'W/"v1"'],
        valid: true,
    },
    {
        name: "a different weak ETag cannot certify the stored response",
        storedValidator: 'etag: W/"v1"',
        responseHeaders: { etag: 'W/"v2"' },
        expectedConditional: ["if-none-match", 'W/"v1"'],
        valid: false,
    },
    {
        name: "a missing response validator cannot certify a Last-Modified-nominated response",
        storedValidator: "last-modified: Tue, 15 Nov 1994 12:45:26 GMT",
        responseHeaders: {},
        expectedConditional: ["if-modified-since", "Tue, 15 Nov 1994 12:45:26 GMT"],
        valid: false,
    },
    {
        name: "an ETag list is not a singular response validator",
        storedValidator: 'etag: "v1"',
        responseHeaders: { etag: '"v1", "v2"' },
        expectedConditional: ["if-none-match", '"v1"'],
        valid: false,
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
    test(`{§revalidation} 304 correspondence: ${name}`, async () => {
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
                        "https://problems.plurnk.xyz/scheme/http/fetch-failed",
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

test("{§http-lifecycle} READ revalidation: 200 (changed) re-fetches + streams normally despite a prior entry", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("old", "text/plain", stampedHeader(500_000, '\netag: "v1"')));
    await withFetch(mockFetch(200, "OK", ["fresh content"], { "content-type": "text/plain" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
    });
    assert.equal(inspect().storedEntry?.channels.body?.content, "fresh content");
    assert.equal(inspect().opened, null, "a finite replacement does not create a stream");
});

test("{§revalidation} READ revalidation: no prior entry → no conditional headers, full fetch", async () => {
    const { ctx } = makeCtx(); // 404 on read
    let hadConditional = false;
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        hadConditional = h.has("if-none-match") || h.has("if-modified-since");
        return new Response("body", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withFetch(probe, async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/x", "/x")), ctx);
    });
    assert.equal(hadConditional, false);
});

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
    test(`{§revalidation} cache variant: ${name} receives authoritative package evidence`, async () => {
        const { ctx, inspect } = makeCtx();
        await withFetch(async () => new Response("fresh", { status: 200, headers: responseHeaders }), async () => {
            await prepareRepresentation(new Http(), readStmt(
                urlTarget("https://example.com/variant", "/variant"),
                null,
                requestHeaders.length === 0 ? null : [JSON.stringify(Object.fromEntries(requestHeaders))],
            ), ctx);
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

test("{§http-lifecycle} cache variant: explicit request metadata bypasses a TTL-fresh default representation", async () => {
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
            await prepareRepresentation(new Http(), readStmt(
                urlTarget("https://example.com/account", "/account"),
                null,
                ["{\"Authorization\":\"Bearer private\"}"],
            ), ctx);
        });
    });
    assert.equal(fetched, true);
    assert.equal(conditional, false, "validators from the default representation do not cross request metadata");
    assert.equal(inspect().storedEntry?.channels.body?.content, "private representation");
});

test("{§http-lifecycle} cache variant: explicit request metadata also bypasses stale validators", async () => {
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
            await prepareRepresentation(new Http(), readStmt(
                urlTarget("https://example.com/account", "/account"),
                null,
                ["{\"Authorization\":\"Bearer private\"}"],
            ), ctx);
        });
    });
    assert.equal(conditional, false);
});

test("{§http-lifecycle} cache variant: a bypass marker cannot supply TTL content or validators", async () => {
    const header = stampedHeader(1000, "\nvary: Accept-Language\netag: \"variant\"", "bypass");
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

test("{§http-lifecycle} cache variant: a 304 that introduces Vary retires default reuse", async () => {
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

test("{§http-lifecycle} exact FIND preparation reacquires request metadata through WebFetcher instead of reusing another variant", async () => {
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
        const result = await prepareExactFind(new Http(), findStmt(
            urlTarget("https://example.com/account", "/account"),
            null,
            ["{\"Authorization\":\"Bearer private\"}"],
        ), ctx);
        assert.equal(result.status, 200);
    });
    assert.equal(authorization, "Bearer private");
    assert.equal(inspect().wrote?.entry.channels.body?.content, "private");
    assert.match(inspect().wrote?.entry.channels.header?.content ?? "", /x-plurnk-cache-variant: bypass$/m);
});

for (const state of ["active", "errored"] as const) {
    test(`{§http-lifecycle} exact FIND preparation cannot reuse a ${state} default representation`, async () => {
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

test("{§http-lifecycle} TTL: fresh stamp serves the stored copy with ZERO round-trips", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("cached page", "text/html", stampedHeader(1000)));
    let fetched = false;
    await withTtl("60000", async () => {
        await withFetch(async () => { fetched = true; throw new Error("must not fetch"); }, async () => {
            const r = await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
            assert.equal(r.status, 200);
        });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().opened, null);
    assert.equal(inspect().storedEntry?.channels.body?.content, "cached page");
});

test("{§revalidation} cache policy: no-store evidence supplies neither TTL content nor validators", async () => {
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

for (const { status, policy, reusable } of [
    { status: 200, policy: "", reusable: true },
    { status: 201, policy: "", reusable: false },
    { status: 202, policy: "", reusable: false },
    { status: 203, policy: "", reusable: true },
    { status: 206, policy: "", reusable: false },
    { status: 299, policy: "", reusable: false },
    { status: 300, policy: "", reusable: true },
    { status: 301, policy: "", reusable: true },
    { status: 302, policy: "", reusable: false },
    { status: 307, policy: "", reusable: false },
    { status: 308, policy: "", reusable: true },
    { status: 201, policy: "max-age=60", reusable: true },
    { status: 202, policy: "max-age=60", reusable: true },
    { status: 202, policy: "public", reusable: true },
    { status: 202, policy: "private", reusable: false },
    { status: 200, policy: "private, public, s-maxage=60", reusable: false },
    { status: 200, policy: 'private="set-cookie", max-age=60', reusable: false },
    { status: 201, policy: "s-maxage=60", reusable: true },
    { status: 202, policy: "s-maxage=60", reusable: true },
    { status: 200, policy: "s-maxage=60, no-store", reusable: false },
    { status: 202, policy: "public, no-store", reusable: false },
    { status: 206, policy: "max-age=60, public", reusable: false },
    { status: 299, policy: "max-age=60", reusable: true },
]) {
    test(`{§revalidation} READ and FIND reuse eligibility: HTTP ${status}, ${policy || "no explicit permission"}`, async () => {
        const { ctx, inspect } = makeCtx();
        const http = new Http();
        const target = urlTarget("https://example.com/eligibility", "/eligibility");
        const requests: Headers[] = [];
        await withTtl("60000", async () => {
            await withFetch(async (_url, init) => {
                requests.push(new Headers(init?.headers));
                return new Response(`response ${requests.length}`, {
                    status,
                    headers: {
                        "content-type": "text/plain",
                        "cache-control": policy,
                        etag: '"stored"',
                    },
                });
            }, async () => {
                assert.equal((await prepareRepresentation(http, readStmt(target), ctx)).status, 200);
                assert.equal(inspect().storedEntry?.channels.body?.content, "response 1", "ineligible content still exists as evidence");
                assert.match(inspect().storedEntry?.channels.header?.content ?? "", new RegExp(`^HTTP ${status} `));
                assert.equal((await prepareRepresentation(http, readStmt(target), ctx)).status, 200);
                assert.equal(requests.length, reusable ? 1 : 2, "second READ respects reuse eligibility");
                assert.equal((await prepareExactFind(http, findStmt(target), ctx)).status, 200);
                assert.equal(requests.length, reusable ? 1 : 3, "exact FIND shares eligibility");
            });
        });
        assert.ok(requests.every(headers => !headers.has("if-none-match")), "ineligible evidence supplies no stored validators");
        assert.equal(inspect().storedEntry?.channels.body?.content, `response ${reusable ? 1 : 3}`);
    });
}

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
    {
        name: "s-maxage replaces shorter max-age and expired Expires",
        ageMs: 1000, ttl: "60000",
        cacheHeaders: "cache-control: max-age=0, s-maxage=60\nexpires: Thu, 01 Jan 1970 00:00:00 GMT",
        expectedFetch: false,
    },
    {
        name: "s-maxage replaces longer max-age and future Expires",
        ageMs: 1000, ttl: "60000",
        cacheHeaders: "cache-control: max-age=60, s-maxage=0\nexpires: Thu, 01 Jan 2099 00:00:00 GMT",
        expectedFetch: true,
    },
    {
        name: "s-maxage still respects the operator ceiling",
        ageMs: 2000, ttl: "1000",
        cacheHeaders: "cache-control: s-maxage=60",
        expectedFetch: true,
    },
    {
        name: "s-maxage accounts for upstream Age",
        ageMs: 1000, ttl: "60000",
        cacheHeaders: "cache-control: s-maxage=60\nage: 120",
        expectedFetch: true,
    },
    {
        name: "quoted case-insensitive s-maxage accepted from a recipient",
        ageMs: 1000, ttl: "60000",
        cacheHeaders: 'cache-control: S-MAXAGE="60", max-age=0',
        expectedFetch: false,
    },
    ...["s-maxage", "s-maxage=tomorrow", "s-maxage=-1", "s-maxage=1.5", "s-maxage=60, s-maxage=120", "s-maxage=60\ncache-control: s-maxage=60"].map((directive) => ({
        name: `invalid or ambiguous ${directive} does not fall back to max-age`,
        ageMs: 1000, ttl: "60000",
        cacheHeaders: `cache-control: max-age=60, ${directive}`,
        expectedFetch: true,
    })),
] as const) {
    test(`{§revalidation} cache policy: ${name}`, async () => {
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

test("{§http-lifecycle} cache policy: an expired Expires field bounds the operator heuristic", async () => {
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
    { name: "private", cacheHeaders: "cache-control: private, max-age=60", expectedFetch: true },
    { name: "fresh s-maxage overrides max-age", cacheHeaders: "cache-control: s-maxage=60, max-age=0", expectedFetch: false },
    { name: "expired s-maxage overrides max-age", cacheHeaders: "cache-control: s-maxage=0, max-age=60", expectedFetch: true },
    { name: "invalid s-maxage", cacheHeaders: "cache-control: s-maxage=no, max-age=60", expectedFetch: true },
    { name: "no-cache overrides s-maxage", cacheHeaders: "cache-control: s-maxage=60, no-cache", expectedFetch: true },
] as const) {
    test(`{§revalidation} exact FIND preparation cache policy: ${name}`, async () => {
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

test("{§http-lifecycle} exact FIND preparation cache policy: an unset operator ceiling fails at configuration", async () => {
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
            /PLURNK_SCHEMES_HTTP_TTL_MS is missing from the assembled environment floor/,
        );
    });
});

test("{§http-lifecycle} 304 merges freshness metadata without relabeling a processed representation", async () => {
    const source = Buffer.from("%PDF-cache");
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
        priorEntry(source.toString("base64"), "application/pdf", storedHeader, "projected PDF"),
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
    assert.equal(inspect().storedEntry?.channels.body?.content, source.toString("base64"));
    assert.equal(inspect().storedEntry?.channels.body?.mimetype, "application/pdf");
    assert.equal(inspect().storedEntry?.channels.readable?.content, "projected PDF");

    const { ctx: refreshedCtx } = makeCtx(
        inspect().storedEntry,
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

for (const policy of ["no-store", "private", 'private="set-cookie"']) {
    test(`{§revalidation} 304 ${policy} retires the restored body and its validators from the next request`, async () => {
        const stored = stampedHeader(1000, '\ncache-control: no-cache\netag: "v1"');
        const { ctx, inspect } = makeCtx(priorEntry("cached", "text/plain", stored));
        await withTtl("60000", async () => {
            await withFetch(async () => new Response(null, {
                status: 304,
                headers: { "cache-control": policy, etag: '"v1"' },
            }), async () => {
                await prepareRepresentation(new Http(),
                    readStmt(urlTarget("https://example.com/retired", "/retired")),
                    ctx,
                );
            });
        });
        const refreshedHeader = inspect().storedEntry?.channels.header?.content ?? "";
        assert.ok(refreshedHeader.split("\n").includes(`cache-control: ${policy}`));
        assert.equal(inspect().storedEntry?.channels.body?.content, "cached");

        const { ctx: nextCtx, inspect: nextInspect } = makeCtx(priorEntry("cached", "text/plain", refreshedHeader));
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
        assert.equal(nextInspect().storedEntry?.channels.body?.content, "new body");
    });
}

test("{§http-lifecycle} TTL: a changed projection identity invalidates derived content and its origin validators", async () => {
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
        async binary(_chunks, mimetype) {
            return { bytes: await buffer(_chunks), projectionIdentity: "pdf-reader-v2", readable: {
                content: "new projection",
                mimetype: "text/markdown",
                sourceMimetype: mimetype,
                projectionIdentity: "pdf-reader-v2",
            } };
        },
    });
    const { ctx, inspect } = makeCtx(
        priorEntry(Buffer.from([0]).toString("base64"), "application/pdf", header, "old projection"),
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
    assert.equal(inspect().storedEntry?.channels.readable?.content, "new projection");
    assert.deepEqual(inspect().wrote?.entry.channels.body?.bytes, Buffer.from([1]));
});

test("{§http-lifecycle} TTL: an exact static WebFetcher materialization is reusable", async () => {
    const { ctx, inspect } = makeCtx(priorEntry(
        "materialized",
        "text/plain",
        stampedHeader(1000),
        undefined,
        "static",
    ));
    let fetched = false;
    await withTtl("60000", async () => {
        await withFetch(async () => { fetched = true; throw new Error("must not fetch"); }, async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/materialized", "/materialized")), ctx);
        });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().storedEntry?.channels.body?.content, "materialized");
});

test("{§http-lifecycle} TTL: a completed empty GET is a reusable representation", async () => {
    const { ctx, inspect } = makeCtx(priorEntry("", "text/plain", stampedHeader(1000)));
    let fetched = false;
    await withTtl("60000", async () => {
        await withFetch(async () => { fetched = true; throw new Error("must not fetch"); }, async () => {
            assert.equal(await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/empty", "/empty")), ctx).then((r) => r.status), 200);
        });
    });
    assert.equal(fetched, false);
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().opened, null);
    assert.equal(inspect().storedEntry?.channels.body?.content, "");
});

for (const state of ["active", "errored"] as const) {
    test(`{§revalidation} TTL: an ${state} GET seed cannot supply freshness or validators`, async () => {
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

test("{§http-lifecycle} TTL: stale stamp falls through to the conditional GET (revalidates)", async () => {
    const { ctx } = makeCtx(priorEntry("old", "text/plain", stampedHeader(120_000, "\netag: \"v1\"")));
    let seenINM = "";
    const probe = async (_url: string | URL | Request, init?: RequestInit) => {
        seenINM = new Headers(init?.headers).get("if-none-match") ?? "";
        return new Response("fresh", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await withTtl("60000", async () => {
        await withFetch(probe, async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        });
    });
    assert.equal(seenINM, "\"v1\""); // past the window → the 304 phase owns freshness
});

test("{§http-lifecycle} READ revalidation: 304 restores a completed empty representation", async () => {
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
        }), async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/empty", "/empty")), ctx);
        });
    });
    assert.equal(seenINM, '"empty"');
    assert.equal(inspect().wrote?.entry.channels.body?.content, "");
    assert.equal(inspect().opened, null);
});

test("{§http-lifecycle} TTL: package-appended metadata wins over a same-named origin header", async () => {
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

test("{§http-lifecycle} TTL: an unmarked authored entry remains outside HTTP acquisition", async () => {
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
        await withFetch(probe, async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/m", "/m")), ctx);
        });
    });
    assert.equal(fetched, false);
    assert.equal(conditional, false);
    assert.equal(inspect().wrote, null);
    assert.equal(inspect().storedEntry?.channels.body?.content, "materialized");
});

test("{§http-lifecycle} TTL: explicit 0 disables the window — fresh stamp still revalidates", async () => {
    const { ctx } = makeCtx(priorEntry("cached", "text/plain", stampedHeader(1000, "\netag: \"v1\"")));
    let fetched = false;
    const probe = async () => {
        fetched = true;
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    };
    await withTtl("0", async () => {
        await withFetch(probe, async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx);
        });
    });
    assert.equal(fetched, true);
});

test("{§http-host-policy} TTL: unset crashes naming the var (floor-set knob, no silent default)", async () => {
    const { ctx } = makeCtx(priorEntry("cached", "text/plain", stampedHeader(1000)));
    await withTtl(undefined, async () => {
        await assert.rejects(
            prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/p", "/p")), ctx),
            /PLURNK_SCHEMES_HTTP_TTL_MS is missing from the assembled environment floor/,
        );
    });
});

test("{§http-lifecycle} stamp: #writeHeader materializes x-plurnk-fetched-at; 304 re-serve refreshes it", async () => {
    const { ctx, inspect } = makeCtx();
    await withFetch(mockFetch(200, "OK", ["x"], { "content-type": "text/plain" }), async () => {
        await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/s", "/s")), ctx);
    });
    const header = inspect().storedEntry?.channels.header?.content ?? "";
    assert.match(header, /^x-plurnk-fetched-at: \d{4}-/m); // stamped at materialization

    const old = stampedHeader(500_000, "\netag: \"v1\"");
    const { ctx: ctx2, inspect: inspect2 } = makeCtx(priorEntry("cached", "text/plain", old));
    await withTtl("0", async () => {
        await withFetch(async () => new Response(null, {
            status: 304,
            headers: { etag: '"v1"' },
        }), async () => {
            await prepareRepresentation(new Http(), readStmt(urlTarget("https://example.com/s", "/s")), ctx2);
        });
    });
    const served = inspect2().storedEntry?.channels.header?.content ?? "";
    const oldMs = Date.parse(/x-plurnk-fetched-at: (.+)$/m.exec(old)![1]);
    const newMs = Date.parse(/x-plurnk-fetched-at: (.+)$/m.exec(served)![1]);
    assert.ok(newMs > oldMs, "origin vouched (304) → stamp refreshed");
});

test("{§http-lifecycle} GET appends authoritative request-method metadata after origin headers", async () => {
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
