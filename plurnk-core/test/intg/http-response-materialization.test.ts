// Composed HTTP response representation coverage {§http-lifecycle} and
// {§http-text-decoding}: direct
// acquisition writes through real SchemeCtx capabilities to SQLite, then
// universal READ observes the durable marker through the binary boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, type ReadStatement, type UrlPath } from "@plurnk/plurnk-contracts";
import Http from "@plurnk/plurnk-schemes-http";
import {
    openMigrated,
    insertWorkspace,
    insertWorker,
    lookThroughScheme,
    makeSchemeCtx,
    makeHandlerCtx,
} from "./_helpers.ts";

const readHttp = (
    http: Http,
    statement: ReadStatement,
    ctx: ReturnType<typeof makeSchemeCtx>,
) => lookThroughScheme("http", http, statement, ctx);

const statement = (
    lineMarker: ReadStatement["lineMarker"] = null,
    pathname = "/logo.png",
): ReadStatement => {
    const target: UrlPath = {
        kind: "url",
        raw: `https://93.184.216.34${pathname}`,
        scheme: "https",
        username: null,
        password: null,
        hostname: "93.184.216.34",
        port: null,
        pathname,
        query: null,
        fragment: null,
    };
    return {
        op: "READ",
        suffix: "READ",
        signal: null,
        target,
        lineMarker,
        body: null,
        position: { line: 1, column: 0 },
    };
};

const parsedRead = (target: string): ReadStatement => {
    const parsed = PlurnkParser.parse(`# PLAN1\nacquire the addressed representation\n\n## READ1 (${target})\n\n## SEND1 [102]\nacquisition pending`);
    const item = parsed.items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "READ",
    );
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error(`no READ parsed from target: ${target}`);
    }
    return item.statement;
};

// Minimal valid one-page PDF whose content stream contains "Hello, world!".
const readablePdf = () => new Uint8Array(Buffer.from(
    "JVBERi0xLjQKJaWx6woxIDAgb2JqCjw8IC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUiA+PgplbmRvYmoKMiAwIG9iago8PCAvVHlwZSAvUGFnZXMgL0tpZHMgWzMgMCBSXSAvQ291bnQgMSA+PgplbmRvYmoKMyAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDMwMCAxNDRdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDQ1ID4+CnN0cmVhbQpCVCAvRjEgMTggVGYgMzYgMTAwIFRkIChIZWxsbywgd29ybGQhKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTQgMDAwMDAgbiAKMDAwMDAwMDA2MyAwMDAwMCBuIAowMDAwMDAwMTIwIDAwMDAwIG4gCjAwMDAwMDAyNDYgMDAwMDAgbiAKMDAwMDAwMDM0MCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo=",
    "base64",
));

const emptyStatement = (): ReadStatement => ({
    op: "READ",
    suffix: "READ",
    signal: null,
    target: {
        kind: "url",
        raw: "https://93.184.216.34/empty",
        scheme: "https",
        username: null,
        password: null,
        hostname: "93.184.216.34",
        port: null,
        pathname: "/empty",
        query: null,
        fragment: null,
    },
    lineMarker: null,
    body: null,
    position: { line: 1, column: 0 },
});

const legacyTextStatement = (): ReadStatement => ({
    op: "READ",
    suffix: "READ",
    signal: null,
    target: {
        kind: "url",
        raw: "https://93.184.216.34/legacy.txt",
        scheme: "https",
        username: null,
        password: null,
        hostname: "93.184.216.34",
        port: null,
        pathname: "/legacy.txt",
        query: null,
        fragment: null,
    },
    lineMarker: null,
    body: null,
    position: { line: 1, column: 0 },
});

test("an unsupported binary response returns an exact 415 without fabricating a text entry", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const http = new Http();
    try {
        globalThis.fetch = async () => new Response(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
            { status: 200, statusText: "OK", headers: { "content-type": "image/png" } },
        );
        const workspaceId = await insertWorkspace(db, `http-binary-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const acquired = await readHttp(http, statement(), ctx);
        assert.equal(acquired.status, 415);
        assert.equal(acquired.problem?.type, "https://problems.plurnk.dev/scheme/http/binary-response-unsupported");

        const entry = await db.test_entries_by_pathname.get<{ id: number; scheme: string }>({
            pathname: "/93.184.216.34/logo.png",
        });
        assert.equal(entry, undefined);

        const reread = await readHttp(http, statement({ marks: [1] }), ctx);
        assert.equal(reread.status, 415);
        assert.equal(reread.problem?.type, "https://problems.plurnk.dev/scheme/http/binary-response-unsupported");
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("a direct readable PDF persists only derived Unicode plus projection evidence", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const http = new Http();
    try {
        globalThis.fetch = async () => new Response(readablePdf(), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/pdf" },
        });
        const workspaceId = await insertWorkspace(db, `http-readable-binary-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const manifest = { ...Http.manifest, name: "https" };
        const handlerCtx = makeHandlerCtx(ctx, manifest);

        assert.equal((await readHttp(http, statement(null, "/paper.pdf"), ctx)).status, 200);
        const entry = await handlerCtx.entries.read("/93.184.216.34/paper.pdf");
        assert.equal(entry.entry?.channels.body.mimetype, "text/markdown");
        assert.match(entry.entry?.channels.body.content ?? "", /Hello, world!/);
        assert.equal(entry.entry?.channels.body.state, "static");
        assert.match(entry.entry?.channels.header.content ?? "", /^content-type: application\/pdf$/m);
        assert.match(
            entry.entry?.channels.header.content ?? "",
            /^x-plurnk-projection-id: [a-f0-9]{64}$/m,
        );

        const reread = await readHttp(http, statement({ marks: [1] }, "/paper.pdf"), ctx);
        assert.equal(reread.status, 200);
        assert.match(reread.content ?? "", /Hello, world!/);
        assert.equal(reread.mimetype, "text/markdown");
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("a direct textual response durably preserves Fetch UTF-8 normalization and charset evidence", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const http = new Http();
    try {
        globalThis.fetch = async () => new Response(
            Uint8Array.from([0x63, 0x61, 0x66, 0xe9]),
            {
                status: 200,
                statusText: "OK",
                headers: { "content-type": "text/plain; charset=windows-1252" },
            },
        );
        const workspaceId = await insertWorkspace(db, `http-text-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const manifest = { ...Http.manifest, name: "https" };
        const handlerCtx = makeHandlerCtx(ctx, manifest);

        assert.equal((await readHttp(http, legacyTextStatement(), ctx)).status, 200);

        const entry = await handlerCtx.entries.read("/93.184.216.34/legacy.txt");
        assert.equal(entry.entry?.channels.body.content, "caf�");
        assert.equal(entry.entry?.channels.body.mimetype, "text/plain");
        assert.equal(entry.entry?.channels.body.state, "static");
        assert.match(
            entry.entry?.channels.header.content ?? "",
            /^content-type: text\/plain; charset=windows-1252$/m,
        );
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("{§http-channel-outcomes}: a hard page-body failure preserves readable server HTML", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.TAVILY_API_KEY;
    const http = new Http();
    try {
        process.env.TAVILY_API_KEY = "tvly-composed-test";
        const source = "<html><body><h1>Preserved source</h1></body></html>";
        globalThis.fetch = async (input) => String(input) === "https://api.tavily.com/extract"
            ? new Response(JSON.stringify({ detail: "invalid test key" }), {
                status: 401,
                headers: { "content-type": "application/json" },
            })
            : new Response(source, {
                status: 200,
                statusText: "OK",
                headers: { "content-type": "text/html" },
            });
        const workspaceId = await insertWorkspace(db, `http-channel-outcomes-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const handlerCtx = makeHandlerCtx(ctx, { ...Http.manifest, name: "https" });
        const pathname = "/93.184.216.34/hard.html";

        const acquired = await readHttp(http, statement(null, "/hard.html"), ctx);
        assert.equal(acquired.status, 502);
        assert.equal(
            acquired.problem?.type,
            "https://problems.plurnk.dev/scheme/http/tavily-authentication-failed",
        );

        const stored = await handlerCtx.entries.read(pathname);
        assert.equal(stored.entry?.channels.body.state, "errored");
        assert.equal(stored.entry?.channels.header.state, "static");
        assert.equal(stored.entry?.channels.html.state, "static");
        assert.equal(stored.entry?.channels.html.content, source);

        const scoped = statement({ marks: [1] }, "/hard.html");
        if (scoped.target?.kind !== "url") throw new Error("HTTP test helper produced a non-URL target");
        const htmlRead: ReadStatement = {
            ...scoped,
            target: {
                ...scoped.target,
                raw: `${scoped.target.raw}#html`,
                fragment: "html",
            },
        };
        const reread = await readHttp(http, htmlRead, ctx);
        assert.equal(reread.status, 200);
        assert.equal(reread.content, source, "universal text scope preserves the exact source characters");
        assert.equal(reread.mimetype, "text/markdown", "scoped text follows the universal text-primitive contract");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
        else process.env.TAVILY_API_KEY = originalKey;
        await db.close();
    }
});

test("an empty finite GET materializes atomically and remains reusable through 304 and TTL", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    const http = new Http();
    try {
        const firstStarted = Promise.withResolvers<void>();
        const firstResponse = Promise.withResolvers<Response>();
        let requests = 0;
        globalThis.fetch = async (_url, init) => {
            requests += 1;
            if (requests === 1) {
                firstStarted.resolve();
                return await firstResponse.promise;
            }
            if (requests === 2) {
                assert.equal(new Headers(init?.headers).get("if-none-match"), '"empty-v1"');
                return new Response(null, {
                    status: 304,
                    statusText: "Not Modified",
                    headers: { etag: '"empty-v1"' },
                });
            }
            throw new Error("a fresh completed representation must not perform another request");
        };

        const workspaceId = await insertWorkspace(db, `http-empty-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const handlerCtx = makeHandlerCtx(ctx, { ...Http.manifest, name: "https" });
        const pathname = "/93.184.216.34/empty";

        const acquiring = readHttp(http, emptyStatement(), ctx);
        await firstStarted.promise;
        const inFlight = await handlerCtx.entries.read(pathname);
        firstResponse.resolve(new Response(null, {
            status: 204,
            statusText: "No Content",
            headers: { "content-type": "text/plain", etag: '"empty-v1"' },
        }));
        const acquired = await acquiring;
        assert.equal(inFlight.status, 404, "finite preparation does not publish a partial representation");
        assert.equal(acquired.status, 204);
        assert.equal(acquired.content, "");

        const completed = await handlerCtx.entries.read(pathname);
        assert.equal(completed.entry?.channels.body.content, "");
        assert.equal(Object.keys(completed.entry?.channels ?? {}).length, 3);
        assert.equal(completed.entry?.channels.body.state, "static");
        assert.equal(completed.entry?.channels.header.state, "static");
        assert.equal(completed.entry?.channels.html.state, "errored");
        assert.equal(completed.entry?.channels.html.producerResult?.status, 502);

        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "0";
        assert.equal((await readHttp(http, emptyStatement(), ctx)).status, 204);
        assert.equal(requests, 2, "stale empty representation revalidated through 304");
        assert.equal((await handlerCtx.entries.read(pathname)).entry?.channels.body.state, "static");

        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "60000";
        assert.equal((await readHttp(http, emptyStatement(), ctx)).status, 204);
        assert.equal(requests, 2, "fresh empty representation used the TTL fast path");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = originalTtl;
        await db.close();
    }
});

// {§revalidation}: exercise the model syntax through parser, scheme, and durable entry state.
test("parser-produced request metadata cannot share a fresh HTTP representation", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    const http = new Http();
    try {
        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "60000";
        const requests: Array<{ authorization: string | null; conditional: boolean }> = [];
        const bodies = ["public v1", "private", "public v2"];
        globalThis.fetch = async (_url, init) => {
            const headers = new Headers(init?.headers);
            requests.push({
                authorization: headers.get("authorization"),
                conditional: headers.has("if-none-match") || headers.has("if-modified-since"),
            });
            return new Response(bodies[requests.length - 1], {
                status: 200,
                headers: { "content-type": "text/plain", etag: `"account-${requests.length}"` },
            });
        };

        const workspaceId = await insertWorkspace(db, `http-variants-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const handlerCtx = makeHandlerCtx(ctx, { ...Http.manifest, name: "https" });
        const publicRead = parsedRead("https://93.184.216.34/account");
        const privateRead = parsedRead(
            "https://93.184.216.34/account{Authorization: Bearer private}",
        );

        assert.equal((await readHttp(http, publicRead, ctx)).status, 200);
        assert.match(
            (await handlerCtx.entries.read("/93.184.216.34/account")).entry?.channels.header.content ?? "",
            /^x-plurnk-cache-variant: default$/m,
        );

        assert.equal((await readHttp(http, privateRead, ctx)).status, 200);
        const privateEntry = await handlerCtx.entries.read("/93.184.216.34/account");
        assert.equal(privateEntry.entry?.channels.body.content, "private");
        assert.match(
            privateEntry.entry?.channels.header.content ?? "",
            /^x-plurnk-cache-variant: bypass$/m,
        );

        assert.equal((await readHttp(http, publicRead, ctx)).status, 200);
        const finalEntry = await handlerCtx.entries.read("/93.184.216.34/account");
        assert.equal(finalEntry.entry?.channels.body.content, "public v2");
        assert.match(
            finalEntry.entry?.channels.header.content ?? "",
            /^x-plurnk-cache-variant: default$/m,
        );
        assert.deepEqual(requests, [
            { authorization: null, conditional: false },
            { authorization: "Bearer private", conditional: false },
            { authorization: null, conditional: false },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = originalTtl;
        await db.close();
    }
});

test("a durable no-store response is operation evidence, not a reusable HTTP cache entry", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    const http = new Http();
    try {
        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "60000";
        const requests: Array<{ conditional: boolean }> = [];
        globalThis.fetch = async (_url, init) => {
            const headers = new Headers(init?.headers);
            requests.push({
                conditional: headers.has("if-none-match") || headers.has("if-modified-since"),
            });
            return new Response(`acquisition ${requests.length}`, {
                status: 200,
                headers: {
                    "cache-control": "no-store",
                    "content-type": "text/plain",
                    etag: `"evidence-${requests.length}"`,
                },
            });
        };

        const workspaceId = await insertWorkspace(db, `http-no-store-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const handlerCtx = makeHandlerCtx(ctx, { ...Http.manifest, name: "https" });
        const read = parsedRead("https://93.184.216.34/evidence");
        const pathname = "/93.184.216.34/evidence";

        assert.equal((await readHttp(http, read, ctx)).status, 200);
        const first = await handlerCtx.entries.read(pathname);
        assert.equal(first.entry?.channels.body.content, "acquisition 1");
        assert.match(first.entry?.channels.header.content ?? "", /^cache-control: no-store$/m);

        assert.equal((await readHttp(http, read, ctx)).status, 200);
        assert.equal((await handlerCtx.entries.read(pathname)).entry?.channels.body.content, "acquisition 2");
        assert.deepEqual(requests, [{ conditional: false }, { conditional: false }]);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = originalTtl;
        await db.close();
    }
});
