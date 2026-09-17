// Composed HTTP response representation coverage {§http-lifecycle} and
// {§http-text-decoding}: direct
// acquisition writes through real SchemeCtx capabilities to SQLite, then
// universal READ observes the durable marker through the binary boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type ReadStatement, type SendStatement, type UrlPath } from "@plurnk/plurnk-contracts";
import Http from "@plurnk/plurnk-schemes-http";
import MaterializerRegistry from "@plurnk/plurnk-schemes-http/materializer";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openMigrated, insertWorkspace, insertWorker, lookThroughScheme, makeSchemeCtx, makeHandlerCtx, fixtureExecutors } from "./_helpers.ts";

const readHttp = (
    http: Http,
    statement: ReadStatement,
    ctx: ReturnType<typeof makeSchemeCtx>,
) => lookThroughScheme("https", http, statement, ctx);

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
        metadata: null,
        op: "READ",
        aside: null,
        target,
        lineMarker,
        matcher: null, body: null,
        position: { line: 1, column: 0 },
    };
};

const parsedRead = (target: string, metadata: readonly string[] = []): ReadStatement => {
    const modifiers = metadata.map((block) => ` [${block}]`).join("");
    const parsed = PlurnkParser.parse(`
\`\`\`READ (${target})${modifiers}\`\`\`
\`\`\`NOTE
acquisition pending
\`\`\``, { executors: fixtureExecutors(`
\`\`\`READ (${target})${modifiers}\`\`\`
\`\`\`NOTE
acquisition pending
\`\`\``) });
    const item = parsed.items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "READ",
    );
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error(`no READ parsed from target: ${target}`);
    }
    return item.statement;
};

test("{§http-channel-outcomes} finite origin statuses never become nonterminal channel states", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const server = createServer((request, response) => {
        const status = Number(request.url?.slice(1)) || 404;
        response.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "max-age=60" });
        response.end(status === 204 ? undefined : `origin ${status}`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
        server.closeAllConnections();
        return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const authority = `127.0.0.1:${address.port}`;
    const workspaceId = await insertWorkspace(db, `http-status-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, workerId });
    const stored = await makeHandlerCtx(ctx, { ...Http.manifest, name: "http" }, authority);
    const http = new Http();
    for (const status of [200, 201, 202, 203, 204, 206, 299, 300, 302, 307, 400, 404, 503, 599, 600, 999]) {
        await t.test(`HTTP ${status}`, async () => {
            const read = parsedRead(`http://${authority}/${status}`);
            const expected = status === 204 ? 204 : status > 599 ? 502 : status >= 400 ? status : 200;
            for (let attempt = 0; attempt < 2; attempt++) {
                const result = await readHttp(http, read, ctx);
                assert.equal(result.status, expected, JSON.stringify(result));
                assert.equal(result.content, status === 204 ? "" : `origin ${status}`);
                const entry = (await stored.entries.read(`/${status}`)).entry;
                assert.ok(entry);
                assert.match(entry.channels.header.content, new RegExp(`^HTTP ${status} `));
                assert.equal(entry.channels.body.state, status >= 400 ? "errored" : "static");
                if (status >= 400) {
                    assert.equal(result.problem?.originStatus, status);
                    assert.equal(result.problem?.type, `https://problems.plurnk.xyz/scheme/http/${status > 599 ? "invalid-response-status" : "http-response-status"}`);
                }
            }
        });
    }
});

for (const status of [201, 202, 206]) {
    test(`{§revalidation} a durable HTTP ${status} body remains evidence without satisfying the next READ`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const requests: Headers[] = [];
        t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
            if (String(url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            requests.push(new Headers(init?.headers));
            return new Response(`revision ${requests.length}`, {
                status,
                headers: { "content-type": "text/plain", etag: '"v1"' },
            });
        });
        const workspaceId = await insertWorkspace(db, `http-ineligible-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const stored = await makeHandlerCtx(ctx, { ...Http.manifest, name: "https" }, "93.184.216.34");
        const http = new Http();
        const read = parsedRead("https://93.184.216.34/ineligible");
        for (const revision of [1, 2]) {
            const result = await readHttp(http, read, ctx);
            assert.equal(result.status, 200, JSON.stringify(result));
            assert.equal(result.content, `revision ${revision}`);
            const entry = (await stored.entries.read("/ineligible")).entry;
            assert.equal(entry?.channels.body.content, `revision ${revision}`);
            assert.match(entry?.channels.header.content ?? "", new RegExp(`^HTTP ${status} `));
        }
        assert.equal(requests.length, 2);
        assert.ok(requests.every(headers => !headers.has("if-none-match")));
    });
}

// Minimal valid one-page PDF whose content stream contains "Hello, world!".
const readablePdf = () => new Uint8Array(Buffer.from(
    "JVBERi0xLjQKJaWx6woxIDAgb2JqCjw8IC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUiA+PgplbmRvYmoKMiAwIG9iago8PCAvVHlwZSAvUGFnZXMgL0tpZHMgWzMgMCBSXSAvQ291bnQgMSA+PgplbmRvYmoKMyAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDMwMCAxNDRdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDQ1ID4+CnN0cmVhbQpCVCAvRjEgMTggVGYgMzYgMTAwIFRkIChIZWxsbywgd29ybGQhKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTQgMDAwMDAgbiAKMDAwMDAwMDA2MyAwMDAwMCBuIAowMDAwMDAwMTIwIDAwMDAwIG4gCjAwMDAwMDAyNDYgMDAwMDAgbiAKMDAwMDAwMDM0MCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo=",
    "base64",
));

for (const mode of ["complete", "oversize", "interrupted"] as const) {
    test(`{§http-binary-source} mutation response (${mode}) preserves headers and publishes only complete binary content`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, `http-mutation-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const handlerCtx = await makeHandlerCtx(ctx, { ...Http.manifest, name: "https" }, "93.184.216.34");
        const pdf = readablePdf();
        const maximum = process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES;
        process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES = mode === "oversize" ? "3" : "104857600";
        t.after(() => { if (maximum === undefined) delete process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES; else process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES = maximum; });
        t.mock.method(globalThis, "fetch", async () => new Response(mode === "interrupted" ? new ReadableStream({
            start(controller) { controller.enqueue(pdf.subarray(0, 4)); },
            pull(controller) { controller.error(new Error("connection interrupted")); },
        }) : pdf, { headers: { "content-type": "application/pdf", "x-response-id": "mutation" } }));
        const send = PlurnkParser.parseStatements("```SEND (https://93.184.216.34/paper.pdf)\ncreate\n```").items[0];
        assert.ok(send?.kind === "statement");
        const result = await new Http().send(send.statement as SendStatement, handlerCtx);
        assert.equal(result.status, mode === "complete" ? 102 : mode === "oversize" ? 413 : 500);
        const entry = (await handlerCtx.entries.read("/paper.pdf")).entry;
        assert.ok(entry);
        assert.match(entry.channels.header.content, /^x-response-id: mutation$/m);
        assert.match(entry.channels.header.content, /^x-plurnk-request-method: POST$/m);
        assert.equal(entry.channels.body.mimetype, "application/pdf");
        assert.deepEqual(Buffer.from(entry.channels.body.content, "base64"), mode === "complete" ? Buffer.from(pdf) : Buffer.alloc(0));
        assert.equal(entry.channels.body.state, mode === "complete" ? "closed" : "errored");
        if (mode === "complete") {
            assert.match(entry.channels.readable.content, /^PDF document, 1 page,/u);
            assert.equal(entry.channels.readable.state, "closed");
            assert.match(entry.channels.header.content, /^x-plurnk-projection-id: [a-f0-9]{64}$/m);
        } else {
            assert.equal(entry.channels.body.producerResult?.status, result.status);
            assert.equal(entry.channels.readable.content, "");
            assert.equal(entry.channels.readable.state, "errored");
            assert.equal(entry.channels.readable.producerResult?.status, result.status);
        }
    });
}

const emptyStatement = (): ReadStatement => ({
    metadata: null,
    op: "READ",
    aside: null,
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
    matcher: null, body: null,
    position: { line: 1, column: 0 },
});

const legacyTextStatement = (): ReadStatement => ({
    metadata: null,
    op: "READ",
    aside: null,
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
    matcher: null, body: null,
    position: { line: 1, column: 0 },
});

for (const status of [200, 202, 404]) {
for (const size of [0, 3]) {
    test(`{§http-binary-source} a ${status} binary response with ${size} bytes preserves its source outcome`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const bytes = Uint8Array.from([1, 2, 3].slice(0, size));
        t.mock.method(globalThis, "fetch", async () => new Response(bytes, {
            status, statusText: status === 200 ? "OK" : status === 202 ? "Accepted" : "Not Found", headers: { "content-type": "application/octet-stream" },
        }));
        const workspaceId = await insertWorkspace(db, `http-outcome-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const http = new Http();
        for (const fragment of ["", "#bytes"]) {
            const read = await readHttp(http, parsedRead(`https://93.184.216.34/result.bin${fragment}`), ctx);
            assert.equal(read.status, status === 404 ? 404 : size === 0 ? 204 : 200, JSON.stringify(read));
            assert.equal(read.content, size === 0 ? "" : "01\n02\n03");
            if (status === 404) assert.equal(read.problem?.type, "https://problems.plurnk.xyz/scheme/http/http-response-status");
        }
    });
}
}

test("{§http-binary-source} an invalid image remains byte-readable without invented native media", async () => {
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
        assert.equal(acquired.status, 200);
        assert.equal(acquired.content, "89\n50\n4e\n47\n00\nff");
        assert.equal(acquired.projection, "hex");
        assert.equal(acquired.image, undefined);
        assert.equal(acquired.nativeContentHash, undefined);

        const handlerCtx = await makeHandlerCtx(ctx, { ...Http.manifest, name: "https" }, "93.184.216.34");
        const entry = await handlerCtx.entries.read("/logo.png");
        assert.equal(entry.status, 200);
        assert.deepEqual(Buffer.from(entry.entry!.channels.body.content, "base64"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

        const reread = await readHttp(http, statement({ marks: [1] }), ctx);
        assert.equal(reread.status, 200);
        assert.equal(reread.content, "89");
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

// {§mimetype-pdf-facts} (#542) — a fetched PDF's readable body is its header facts, never extracted
// text; the bytes ride the packet as a native document part on a route that accepts one.
test("{§http-binary-source} a direct PDF retains its complete bytes beside facts and projection evidence", async () => {
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
        const handlerCtx = await makeHandlerCtx(ctx, manifest, "93.184.216.34");

        assert.equal((await readHttp(http, statement(null, "/paper.pdf"), ctx)).status, 200);
        const entry = await handlerCtx.entries.read("/paper.pdf");
        assert.equal(entry.entry?.channels.body.mimetype, "application/pdf");
        assert.deepEqual(Buffer.from(entry.entry?.channels.body.content ?? "", "base64"), Buffer.from(readablePdf()));
        assert.match(entry.entry?.channels.readable.content ?? "", /^PDF document, 1 page, \d+ bytes$/u, "the readable projection is the header facts, nothing extracted");
        assert.equal(entry.entry?.channels.body.state, "static");
        assert.match(entry.entry?.channels.header.content ?? "", /^content-type: application\/pdf$/m);
        assert.match(
            entry.entry?.channels.header.content ?? "",
            /^x-plurnk-projection-id: [a-f0-9]{64}$/m,
        );

        const reread = await readHttp(http, statement({ marks: [1] }, "/paper.pdf"), ctx);
        assert.equal(reread.status, 200);
        assert.equal(reread.content, "25");
        assert.equal(reread.mimetype, "application/pdf");
        const facts = await readHttp(http, parsedRead("https://93.184.216.34/paper.pdf#readable"), ctx);
        assert.equal(facts.status, 200);
        assert.match(facts.content ?? "", /^PDF document, 1 page, \d+ bytes$/u);
        assert.deepEqual(facts.document, { mimetype: "application/pdf", pages: 1, bytes: readablePdf().byteLength });
        assert.ok(facts.nativeContentHash);
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
        const handlerCtx = await makeHandlerCtx(ctx, manifest, "93.184.216.34");

        assert.equal((await readHttp(http, legacyTextStatement(), ctx)).status, 200);

        const entry = await handlerCtx.entries.read("/legacy.txt");
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

test("{§http-channel-outcomes}: a hard materializer failure is the readable channel's; the source reads whole", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalMaterializer = process.env.PLURNK_SCHEMES_HTTP_MATERIALIZER;
    const http = new Http();
    try {
        process.env.PLURNK_SCHEMES_HTTP_MATERIALIZER = "stub";
        const fixture = resolve(import.meta.dirname, "../../../plurnk-schemes-http/test/fixtures/materializer-stub");
        await MaterializerRegistry.current().discover({
            packageDirs: [{ dir: fixture, name: "@plurnk/test-materializer-stub" }],
        });
        const { __stub } = (await import(pathToFileURL(resolve(fixture, "materializer.js")).href)) as unknown as {
            __stub: { set: (b: unknown) => void };
        };
        __stub.set({
            eligible: () => "stub-extract:v1",
            extract: async () => ({
                outcome: "hard",
                identity: "stub-extract:v1",
                evidence: [],
                problem: {
                    status: 502,
                    code: "stub-authentication-failed",
                    detail: "The stub rejected the configured credentials.",
                    retryable: false,
                },
            }),
        });
        const source = "<html><body><h1>Preserved source</h1></body></html>";
        globalThis.fetch = async () => new Response(source, {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/html" },
        });
        const workspaceId = await insertWorkspace(db, `http-channel-outcomes-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const handlerCtx = await makeHandlerCtx(ctx, { ...Http.manifest, name: "https" }, "93.184.216.34");
        const pathname = "/hard.html";

        // {§readable-channel} — the page's source is its body and reads whole; the materializer's
        // hard failure is the readable channel's own.
        const acquired = await readHttp(http, statement(null, "/hard.html"), ctx);
        assert.equal(acquired.status, 200, JSON.stringify(acquired).slice(0, 300));
        assert.equal(acquired.content, source, "the source is the default channel");
        assert.deepEqual(Object.keys(acquired.channels as Record<string, number>), ["#header", "#readable"], "the READ names the page's other channels");

        const stored = await handlerCtx.entries.read(pathname);
        assert.equal(stored.entry?.channels.body.state, "static");
        assert.equal(stored.entry?.channels.body.content, source);
        assert.equal(stored.entry?.channels.header.state, "static");
        assert.equal(stored.entry?.channels.readable.state, "errored");

        const scoped = statement(null, "/hard.html");
        if (scoped.target?.kind !== "url") throw new Error("HTTP test helper produced a non-URL target");
        const readableRead: ReadStatement = {
            ...scoped,
            target: {
                ...scoped.target,
                raw: `${scoped.target.raw}#readable`,
                fragment: "readable",
            },
        };
        const projection = await readHttp(http, readableRead, ctx);
        assert.equal(projection.status, 502);
        assert.equal(
            projection.problem?.type,
            "https://problems.plurnk.xyz/scheme/http/stub-authentication-failed",
        );
    } finally {
        globalThis.fetch = originalFetch;
        if (originalMaterializer === undefined) delete process.env.PLURNK_SCHEMES_HTTP_MATERIALIZER;
        else process.env.PLURNK_SCHEMES_HTTP_MATERIALIZER = originalMaterializer;
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
            if (String(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
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
        const handlerCtx = await makeHandlerCtx(ctx, { ...Http.manifest, name: "https" }, "93.184.216.34");
        const pathname = "/empty";

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
        // {§readable-channel} — a plain-text response has no projection: body and header only.
        assert.deepEqual(Object.keys(completed.entry?.channels ?? {}).sort(), ["body", "header"]);
        assert.equal(completed.entry?.channels.body.state, "static");
        assert.equal(completed.entry?.channels.header.state, "static");

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
            if (String(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
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
        const handlerCtx = await makeHandlerCtx(ctx, { ...Http.manifest, name: "https" }, "93.184.216.34");
        const publicRead = parsedRead("https://93.184.216.34/account");
        const privateRead = parsedRead(
            "https://93.184.216.34/account",
            ['{"Authorization": "Bearer private"}'],
        );

        assert.equal((await readHttp(http, publicRead, ctx)).status, 200);
        assert.match(
            (await handlerCtx.entries.read("/account")).entry?.channels.header.content ?? "",
            /^x-plurnk-cache-variant: default$/m,
        );

        assert.equal((await readHttp(http, privateRead, ctx)).status, 200);
        const privateEntry = await handlerCtx.entries.read("/account");
        assert.equal(privateEntry.entry?.channels.body.content, "private");
        assert.match(
            privateEntry.entry?.channels.header.content ?? "",
            /^x-plurnk-cache-variant: bypass$/m,
        );

        assert.equal((await readHttp(http, publicRead, ctx)).status, 200);
        const finalEntry = await handlerCtx.entries.read("/account");
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
            if (String(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
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
        const handlerCtx = await makeHandlerCtx(ctx, { ...Http.manifest, name: "https" }, "93.184.216.34");
        const read = parsedRead("https://93.184.216.34/evidence");
        const pathname = "/evidence";

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

test("{§revalidation} #288: a 304 with a strong etag of the stored weak etag's opaque value refreshes instead of failing", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    const http = new Http();
    try {
        let requests = 0;
        globalThis.fetch = async (_url, init) => {
            if (String(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            requests += 1;
            if (requests === 1) {
                return new Response("legacy body v1", {
                    status: 200,
                    headers: { "content-type": "text/plain", etag: 'W/"opaque-1"', "last-modified": "Wed, 05 Aug 2026 16:23:37 GMT" },
                });
            }
            assert.equal(new Headers(init?.headers).get("if-none-match"), 'W/"opaque-1"', "the stored weak etag becomes the conditional");
            return new Response(null, {
                status: 304,
                statusText: "Not Modified",
                headers: { etag: '"opaque-1"', "last-modified": "Wed, 05 Aug 2026 16:23:37 GMT" },
            });
        };

        const workspaceId = await insertWorkspace(db, `http-weak-strong-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });

        const acquired = await readHttp(http, legacyTextStatement(), ctx);
        assert.equal(acquired.status, 200, "the weak-etag representation materializes");
        assert.equal(acquired.content, "legacy body v1");

        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "0";
        const refreshed = await readHttp(http, legacyTextStatement(), ctx);
        assert.equal(refreshed.status, 200, "a strong-etag 304 of the same opaque value corresponds (weak comparison per RFC 9110 §8.8.3.2)");
        assert.equal(refreshed.content, "legacy body v1");
        assert.equal(requests, 2, "one conditional revalidation, no full reacquisition");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = originalTtl;
        await db.close();
    }
});

test("{§revalidation} #288: a 304 that cannot identify the stored representation falls back to one unconditional GET", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    const http = new Http();
    try {
        let requests = 0;
        globalThis.fetch = async (_url, init) => {
            if (String(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            requests += 1;
            if (requests === 1) {
                return new Response("legacy body v1", {
                    status: 200,
                    headers: { "content-type": "text/plain", etag: 'W/"opaque-1"', "last-modified": "Wed, 05 Aug 2026 16:23:37 GMT" },
                });
            }
            if (requests === 2) {
                assert.equal(new Headers(init?.headers).get("if-none-match"), 'W/"opaque-1"', "the first revalidation goes out conditional");
                return new Response(null, {
                    status: 304,
                    statusText: "Not Modified",
                    headers: { etag: 'W/"opaque-2"' },
                });
            }
            assert.equal(new Headers(init?.headers).get("if-none-match"), null, "the genuine-mismatch fallback re-issues unconditionally");
            return new Response("legacy body v2", {
                status: 200,
                headers: { "content-type": "text/plain", etag: 'W/"opaque-2"' },
            });
        };

        const workspaceId = await insertWorkspace(db, `http-mismatch-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });

        const acquired = await readHttp(http, legacyTextStatement(), ctx);
        assert.equal(acquired.status, 200);
        assert.equal(acquired.content, "legacy body v1");

        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "0";
        const refreshed = await readHttp(http, legacyTextStatement(), ctx);
        assert.equal(refreshed.status, 200, "a genuine etag mismatch reacquires unconditionally instead of surfacing an unrecoverable 502");
        assert.equal(refreshed.content, "legacy body v2");
        assert.equal(requests, 3, "conditional revalidation, mismatch, one unconditional fallback");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = originalTtl;
        await db.close();
    }
});
