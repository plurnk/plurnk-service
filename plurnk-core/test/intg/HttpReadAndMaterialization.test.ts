import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Http from "@plurnk/plurnk-schemes-http";
import MaterializerRegistry from "@plurnk/plurnk-schemes-http/materializer";
import { type UrlPath, type ReadStatement, type SendStatement } from "@plurnk/plurnk-contracts";
import { type Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { makeSchemeCtx, readThroughScheme, makeHandlerCtx, settleOutbound } from "./_scheme.ts";
import { resolve } from "node:path";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { fixtureExecutors } from "./_mock.ts";
import { requestUrl } from "../../../scripts/lib/test-fetch.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";


describe("http-read-scope", () => {
// {§scheme-surface}












const HOST = "93.184.216.34";

// 20 numbered source lines; a page this size is trivially real, and the
// numbering makes any window violation self-evident.
const htmlPage = (): string => [
    "<!DOCTYPE html>",
    "<html>",
    "<head><title>scope fixture</title></head>",
    "<body>",
    ...Array.from({ length: 20 }, (_, i) => `<p>line-${i + 5}</p>`),
    "</body>",
    "</html>",
    "",
].join("\n");

const parseRead = (dsl: string): ReadStatement => {
    const found = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find(
        (item) => item.kind === "statement" && item.statement.op === "READ",
    );
    if (found === undefined) throw new Error(`no READ parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: ReadStatement }).statement;
};

const setup = async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `http-scope-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "scope");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const schemes = new SchemeRegistry();
    schemes.register("https", new Http());
    const engine = new Engine({ db, schemes, mimetypes });
    return { db, engine, mimetypes, ids: { workspaceId, sessionId, loopId, turnId } };
};

const readContent = async (
    db: Db, ids: { workspaceId: number; sessionId: number; loopId: number; turnId: number }, sequence: number,
): Promise<{ content: string | null; status: number }> => {
    const row = await db.log_read_by_coordinate.get<{ rx: string }>({
        session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence,
    });
    if (row === undefined) throw new Error(`no stored result for sequence ${sequence}`);
    return JSON.parse(row.rx) as { content: string | null; status: number };
};

const windowOf = (source: string, first: number, last: number): string =>
    source.split("\n").slice(first - 1, last).join("\n");

for (const pretty of [false, true]) {
    for (const prepared of [false, true]) {
        test(`{§scheme-surface}: HTTP JSONPath locations drive exact value READs (${pretty ? "pretty" : "compact"}, ${prepared ? "warm" : "cold"})`, async (t) => {
            const { db, engine, ids } = await setup();
            t.after(() => db.close());
            const releases = [
                { version: "v26.8.1", lts: false },
                { version: "v24.14.0", lts: "Krypton" },
                { version: "v22.18.0", lts: "Jod" },
            ];
            const requests: string[] = [];
            t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
                if (requestUrl(input).endsWith("/llms.txt")) return new Response(null, { status: 404 });
                requests.push(requestUrl(input));
                return new Response(JSON.stringify(releases, null, pretty ? 2 : undefined), {
                    headers: { "content-type": "application/json", "cache-control": "max-age=120" },
                });
            });
            let sequence = 0;
            const run = async (header: string, body: string | null = null) => {
                const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(header, body), { executors: fixtureExecutors(PlurnkParser.frame(header, body)) });
                assert.equal(parsed.items.length, 1);
                const item = parsed.items[0];
                assert.ok(item?.kind === "statement");
                await engine.dispatch({ statement: item.statement, ...ids, sequence: ++sequence, origin: "model" });
                return readContent(db, ids, sequence);
            };
            const url = `https://${HOST}/dist/index.json`;
            if (prepared) assert.equal((await run(`READ (${url})`)).status, 200);
            const found = await run(`FIND (${url}) $[?(@.lts != false)].version`);
            assert.equal(found.status, 200);
            assert.ok(found.content);
            const locations = JSON.parse(found.content) as Array<{ channel?: string; region: string }>;
            assert.equal(locations.length, 2, "the filter excludes the current non-LTS release");
            const values: string[] = [];
            for (const { channel, region } of locations) {
                assert.equal(channel, undefined, "{§channel-selection}: the default channel goes unnamed");
                assert.match(region, /^<\d+,\d+,\d+,\d+>$/u, "{§find-result-projection}: the location is itself the READ scope");
                const value = await run(`READ (${url}) ${region}`);
                assert.equal(value.status, 200);
                assert.ok(value.content);
                values.push(value.content);
            }
            assert.deepEqual(values, ['"v24.14.0"', '"v22.18.0"'], "each READ returns exactly the selected value, including quotes but not its key or colon");
            assert.deepEqual(requests, [url], "scoped follow-up reads reuse the acquired representation");
        });
    }
}

test("{§channel-selection} #283: a scoped READ of a materialized https page's source returns exactly the window", async () => {
    const { db, engine, ids } = await setup();
    const originalFetch = globalThis.fetch;
    try {
        const page = htmlPage();
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (requestUrl(input).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            return new Response(page, {
                status: 200, statusText: "OK", headers: { "content-type": "text/html" },
            });
        });
        let sequence = 0;
        const dispatch = async (statement: ReadStatement) => (await engine.dispatch({
            statement, ...ids, sequence: ++sequence, origin: "model",
        })) as { status: number; rowsWritten?: number };

        const acquired = await dispatch(parseRead(`\`\`\`\`READ (https://${HOST}/scoped)\`\`\`\``));
        assert.equal(acquired.status, 200, "materialization read succeeds");

        // {§channel-selection} — a page's server source is its default channel.
        const scoped = await dispatch(parseRead(`\`\`\`\`READ (https://${HOST}/scoped) <3,16>\`\`\`\``));
        assert.equal(scoped.status, 200, "scoped source read succeeds");
        const result = await readContent(db, ids, sequence);
        assert.equal(
            result.content,
            windowOf(page, 3, 16),
            "the source read returns exactly lines 3..16 — not the complete page",
        );
        const projection = await dispatch(parseRead(`\`\`\`\`READ (https://${HOST}/scoped#readable) <1,-1>\`\`\`\``));
        assert.equal(projection.status, 200, "the readable projection is one fragment away");
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("{§scheme-surface} #283: a scoped READ of a materialized https entry's body channel returns exactly the window", async () => {
    const { db, engine, ids } = await setup();
    const originalFetch = globalThis.fetch;
    try {
        const page = htmlPage();
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (requestUrl(input).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            return new Response(page, {
                status: 200, statusText: "OK", headers: { "content-type": "text/plain" },
            });
        });
        let sequence = 0;
        const dispatch = async (statement: ReadStatement) => (await engine.dispatch({
            statement, ...ids, sequence: ++sequence, origin: "model",
        })) as { status: number; rowsWritten?: number };

        const acquired = await dispatch(parseRead(`\`\`\`\`READ (https://${HOST}/scoped-body)\`\`\`\``));
        assert.equal(acquired.status, 200, "materialization read succeeds");

        const scoped = await dispatch(parseRead(`\`\`\`\`READ (https://${HOST}/scoped-body) <3,16>\`\`\`\``));
        assert.equal(scoped.status, 200, "scoped read succeeds");
        const result = await readContent(db, ids, sequence);
        assert.equal(
            result.content,
            windowOf(page, 3, 16),
            "the default-channel read returns exactly lines 3..16",
        );
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("{§scheme-surface} #283: a scoped READ of a project file still returns exactly the window", async () => {
    const { db, engine, ids } = await setup();
    try {
        let sequence = 0;
        const dispatch = async (statement: ReadStatement) => (await engine.dispatch({
            statement, ...ids, sequence: ++sequence, origin: "model",
        })) as { status: number; rowsWritten?: number };
        const content = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n");
        const seeded = await engine.dispatch({
            statement: {
                metadata: null,
                op: "EDIT", aside: null,
                target: { kind: "url", raw: "workspace:///scope.md", scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/scope.md", query: null, fragment: null },
                lineMarker: null,
                matcher: null, body: content,
                position: { line: 1, column: 0 },
            },
            ...ids, sequence: ++sequence, origin: "model",
        }) as { status: number };
        assert.equal(seeded.status, 201, "seed edit succeeds");
        await dispatch(parseRead(`\`\`\`\`READ (workspace:///scope.md) <3,16>\`\`\`\``));
        const result = await readContent(db, ids, sequence);
        assert.equal(
            result.content,
            windowOf(content, 3, 16),
            "the session-entry read returns exactly lines 3..16",
        );
    } finally {
        await db.close();
    }
});

test("{§channel-selection}: a matcher FIND location names its channel only off the default", async () => {
    const { db, engine, ids } = await setup();
    const originalFetch = globalThis.fetch;
    try {
        const page = [
            "<!DOCTYPE html>",
            "<html>",
            "<head><title>t</title></head>",
            "<body>",
            "<p>v26.7.0 current</p>",
            "<p>v24.18.1 lts</p>",
            "</body>",
            "</html>",
            "",
        ].join("\n");
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (requestUrl(input).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            return new Response(page, {
                status: 200, statusText: "OK", headers: { "content-type": "text/html" },
            });
        });
        let sequence = 0;
        const parseFind = (dsl: string): ReadStatement => {
            const found = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find(
                (item) => item.kind === "statement" && item.statement.op === (dsl.startsWith("````READ") ? "READ" : "FIND"),
            );
            if (found === undefined) throw new Error(`no statement parsed from: ${dsl}`);
            return (found as { kind: "statement"; statement: ReadStatement }).statement;
        };
        const dispatch = async (dsl: string) => (await engine.dispatch({
            statement: parseFind(dsl), ...ids, sequence: ++sequence, origin: "model",
        })) as unknown as { status: number };

        const acquired = await dispatch("````READ (https://93.184.216.34/channel-facts)````");
        assert.equal(acquired.status, 200, "materialization read succeeds");

        await dispatch("````FIND (https://93.184.216.34/channel-facts) /v[0-9.]+/i````");
        const bodyFind = await readContent(db, ids, sequence);
        const bodyLocations = JSON.parse(bodyFind.content ?? "[]") as Array<{ channel?: string }>;
        assert.ok(bodyLocations.length > 0, "the default-channel FIND reports match locations");
        for (const location of bodyLocations) {
            assert.equal(location.channel, undefined, "{§channel-selection}: a default-channel match names no channel");
        }

        await dispatch("````FIND (https://93.184.216.34/channel-facts#readable) /v[0-9.]+/i````");
        const readableFind = await readContent(db, ids, sequence);
        const readableLocations = JSON.parse(readableFind.content ?? "[]") as Array<{ channel?: string }>;
        assert.ok(readableLocations.length > 0, "the #readable-channel FIND reports match locations");
        for (const location of readableLocations) {
            assert.equal(location.channel, "readable", "a #readable-channel match names the readable channel");
        }
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});
});

describe("http-response-materialization", () => {
// Composed HTTP response representation coverage {§http-lifecycle} and
// {§http-lifecycle}: direct
// acquisition writes through real SchemeCtx capabilities to SQLite, then
// universal READ observes the durable marker through the binary boundary.















const readHttp = (
    http: Http,
    statement: ReadStatement,
    ctx: ReturnType<typeof makeSchemeCtx>,
) => readThroughScheme("https", http, statement, ctx);

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
\`\`\`\`READ (${target})${modifiers}\`\`\`\`
\`\`\`\`NOTE
acquisition pending
\`\`\`\``, { executors: fixtureExecutors(`
\`\`\`\`READ (${target})${modifiers}\`\`\`\`
\`\`\`\`NOTE
acquisition pending
\`\`\`\``) });
    const item = parsed.items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "READ",
    );
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error(`no READ parsed from target: ${target}`);
    }
    return item.statement;
};

test("{§http-lifecycle} finite origin statuses never become nonterminal channel states", async (t) => {
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
        return new Promise<void>((settle, reject) => server.close((error) => error ? reject(error) : settle()));
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const authority = `127.0.0.1:${address.port}`;
    const workspaceId = await insertWorkspace(db, `http-status-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
    const stored = await makeHandlerCtx(ctx, { ...Http.manifest, name: "http" }, authority);
    const http = new Http();
    for (const status of [200, 201, 202, 203, 204, 206, 299, 300, 302, 307, 400, 404, 503, 599, 600, 999]) {
        await t.test(`{§http-manifest} HTTP ${status}`, async () => {
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
            if (requestUrl(url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            requests.push(new Headers(init?.headers));
            return new Response(`revision ${requests.length}`, {
                status,
                headers: { "content-type": "text/plain", etag: '"v1"' },
            });
        });
        const workspaceId = await insertWorkspace(db, `http-ineligible-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
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

for (const { policy, reuse, conditional } of [
    { policy: "private, max-age=60", reuse: false, conditional: false },
    { policy: 'private="set-cookie", s-maxage=60', reuse: false, conditional: false },
    { policy: "s-maxage=60, max-age=0", reuse: true, conditional: false },
    { policy: "s-maxage=0, max-age=60", reuse: false, conditional: true },
    { policy: "s-maxage=invalid, max-age=60", reuse: false, conditional: true },
]) {
    test(`{§revalidation} shared-cache ${policy} governs cross-session READ without removing evidence`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const priorTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "60000";
        t.after(() => {
            if (priorTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
            else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = priorTtl;
        });
        const requests: (string | undefined)[] = [];
        const server = createServer((request, response) => {
            if (request.url !== "/resource") { response.writeHead(404).end(); return; }
            requests.push(request.headers["if-none-match"]);
            response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": policy, ETag: '"v1"' });
            response.end(`revision ${requests.length}`);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(() => {
            server.closeAllConnections();
            return new Promise<void>((settle, reject) => server.close((error) => error ? reject(error) : settle()));
        });
        const address = server.address();
        assert.ok(address !== null && typeof address !== "string");
        const authority = `127.0.0.1:${address.port}`;
        const workspaceId = await insertWorkspace(db, `http-shared-${crypto.randomUUID()}`);
        const firstSession = await insertSession(db, workspaceId, null, "first");
        const secondSession = await insertSession(db, workspaceId, null, "second");
        const firstCtx = makeSchemeCtx({ db, workspaceId, sessionId: firstSession });
        const secondCtx = makeSchemeCtx({ db, workspaceId, sessionId: secondSession });
        const stored = await makeHandlerCtx(secondCtx, { ...Http.manifest, name: "http" }, authority);
        const read = parsedRead(`http://${authority}/resource`);
        const http = new Http();
        assert.equal((await readHttp(http, read, firstCtx)).content, "revision 1");
        assert.equal((await stored.entries.read("/resource")).entry?.channels.body.content, "revision 1", "evidence remains accessible to another session");
        const next = await readHttp(http, read, secondCtx);
        assert.equal(next.status, 200, JSON.stringify(next));
        assert.equal(next.content, `revision ${reuse ? 1 : 2}`);
        assert.deepEqual(requests, reuse ? [undefined] : [undefined, conditional ? '"v1"' : undefined]);
        assert.equal((await stored.entries.read("/resource")).entry?.channels.body.content, next.content);
    });
}

// Minimal valid one-page PDF whose content stream contains "Hello, world!".
const readablePdf = () => new Uint8Array(Buffer.from(
    "JVBERi0xLjQKJaWx6woxIDAgb2JqCjw8IC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUiA+PgplbmRvYmoKMiAwIG9iago8PCAvVHlwZSAvUGFnZXMgL0tpZHMgWzMgMCBSXSAvQ291bnQgMSA+PgplbmRvYmoKMyAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDMwMCAxNDRdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDQ1ID4+CnN0cmVhbQpCVCAvRjEgMTggVGYgMzYgMTAwIFRkIChIZWxsbywgd29ybGQhKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTQgMDAwMDAgbiAKMDAwMDAwMDA2MyAwMDAwMCBuIAowMDAwMDAwMTIwIDAwMDAwIG4gCjAwMDAwMDAyNDYgMDAwMDAgbiAKMDAwMDAwMDM0MCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo=",
    "base64",
));

for (const mode of ["complete", "oversize", "interrupted"] as const) {
    test(`{§http-lifecycle} mutation response (${mode}) preserves headers and publishes only complete binary content`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, `http-mutation-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const handlerCtx = await makeHandlerCtx(ctx, { ...Http.manifest, name: "https" }, "93.184.216.34");
        const pdf = readablePdf();
        const maximum = process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES;
        process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES = mode === "oversize" ? "3" : "104857600";
        t.after(() => { if (maximum === undefined) delete process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES; else process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES = maximum; });
        t.mock.method(globalThis, "fetch", async () => new Response(mode === "interrupted" ? new ReadableStream({
            start(controller) { controller.enqueue(pdf.subarray(0, 4)); },
            pull(controller) { controller.error(new Error("connection interrupted")); },
        }) : pdf, { headers: { "content-type": "application/pdf", "x-response-id": "mutation" } }));
        const send = PlurnkParser.parseStatements("````SEND (https://93.184.216.34/paper.pdf)\ncreate\n````").items[0];
        assert.ok(send?.kind === "statement");
        const http = new Http();
        const result = await settleOutbound(http, await http.send(send.statement as SendStatement, handlerCtx), handlerCtx,
            (send.statement as SendStatement).metadata);
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

const plainTextStatement = (): ReadStatement => ({
    metadata: null,
    op: "READ",
    aside: null,
    target: {
        kind: "url",
        raw: "https://93.184.216.34/plain.txt",
        scheme: "https",
        username: null,
        password: null,
        hostname: "93.184.216.34",
        port: null,
        pathname: "/plain.txt",
        query: null,
        fragment: null,
    },
    lineMarker: null,
    matcher: null, body: null,
    position: { line: 1, column: 0 },
});

for (const status of [200, 202, 404]) {
for (const size of [0, 3]) {
    test(`{§http-lifecycle} a ${status} binary response with ${size} bytes preserves its source outcome`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const bytes = Uint8Array.from([1, 2, 3].slice(0, size));
        t.mock.method(globalThis, "fetch", async () => new Response(bytes, {
            status, statusText: status === 200 ? "OK" : status === 202 ? "Accepted" : "Not Found", headers: { "content-type": "application/octet-stream" },
        }));
        const workspaceId = await insertWorkspace(db, `http-outcome-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
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

test("{§http-lifecycle} an invalid image remains byte-readable without invented native media", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const http = new Http();
    try {
        globalThis.fetch = async () => new Response(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
            { status: 200, statusText: "OK", headers: { "content-type": "image/png" } },
        );
        const workspaceId = await insertWorkspace(db, `http-binary-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
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

// {§mimetype-binary-input} (#542) — a fetched PDF's readable body is its header facts, never extracted
// text; the bytes ride the packet as a native document part on a route that accepts one.
test("{§http-lifecycle} a direct PDF retains its complete bytes beside facts and projection evidence", async () => {
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
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
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

test("{§http-lifecycle} a direct textual response durably preserves Fetch UTF-8 normalization and charset evidence", async () => {
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
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const manifest = { ...Http.manifest, name: "https" };
        const handlerCtx = await makeHandlerCtx(ctx, manifest, "93.184.216.34");

        assert.equal((await readHttp(http, plainTextStatement(), ctx)).status, 200);

        const entry = await handlerCtx.entries.read("/plain.txt");
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

test("{§http-lifecycle}: a hard materializer failure is the readable channel's; the source reads whole", async () => {
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
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const handlerCtx = await makeHandlerCtx(ctx, { ...Http.manifest, name: "https" }, "93.184.216.34");
        const pathname = "/hard.html";

        // {§channel-selection} — the page's source is its body and reads whole; the materializer's
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

test("{§channel-selection} an empty finite GET materializes atomically and remains reusable through 304 and TTL", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    const http = new Http();
    try {
        const firstStarted = Promise.withResolvers<void>();
        const firstResponse = Promise.withResolvers<Response>();
        let requests = 0;
        globalThis.fetch = async (_url, init) => {
            if (requestUrl(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
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
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
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
        // {§channel-selection} — a plain-text response has no projection: body and header only.
        assert.deepEqual(Object.keys(completed.entry?.channels ?? {}).toSorted(), ["body", "header"]);
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
test("{§http-lifecycle} parser-produced request metadata cannot share a fresh HTTP representation", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    const http = new Http();
    try {
        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "60000";
        const requests: Array<{ authorization: string | null; conditional: boolean }> = [];
        const bodies = ["public v1", "private", "public v2"];
        globalThis.fetch = async (_url, init) => {
            if (requestUrl(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
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
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
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

test("{§http-lifecycle} a durable no-store response is operation evidence, not a reusable HTTP cache entry", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    const http = new Http();
    try {
        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "60000";
        const requests: Array<{ conditional: boolean }> = [];
        globalThis.fetch = async (_url, init) => {
            if (requestUrl(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
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
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
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

test("{§revalidation} a strong response tag after a stored weak tag reacquires instead of promoting the stored bytes", async () => {
    const db = await openMigrated();
    const originalFetch = globalThis.fetch;
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    const http = new Http();
    try {
        let requests = 0;
        globalThis.fetch = async (_url, init) => {
            if (requestUrl(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            requests += 1;
            if (requests === 1) {
                return new Response("plain body v1", {
                    status: 200,
                    headers: { "content-type": "text/plain", etag: 'W/"opaque-1"', "last-modified": "Wed, 05 Aug 2026 16:23:37 GMT" },
                });
            }
            if (requests === 2) {
                assert.equal(new Headers(init?.headers).get("if-none-match"), 'W/"opaque-1"', "the stored weak etag becomes the conditional");
                return new Response(null, {
                    status: 304,
                    statusText: "Not Modified",
                    headers: { etag: '"opaque-1"', "last-modified": "Wed, 05 Aug 2026 16:23:37 GMT" },
                });
            }
            assert.equal(new Headers(init?.headers).get("if-none-match"), null);
            assert.equal(new Headers(init?.headers).get("if-modified-since"), null);
            return new Response("reacquired body", {
                headers: { "content-type": "text/plain", etag: '"opaque-1"' },
            });
        };

        const workspaceId = await insertWorkspace(db, `http-weak-strong-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });

        const acquired = await readHttp(http, plainTextStatement(), ctx);
        assert.equal(acquired.status, 200, "the weak-etag representation materializes");
        assert.equal(acquired.content, "plain body v1");

        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "0";
        const refreshed = await readHttp(http, plainTextStatement(), ctx);
        assert.equal(refreshed.status, 200, "an unvalidated body remains recoverable through ordinary acquisition");
        assert.equal(refreshed.content, "reacquired body");
        assert.equal(requests, 3, "one conditional revalidation followed by one unconditional acquisition");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = originalTtl;
        await db.close();
    }
});

test("{§revalidation} wire validators select reuse or reacquisition of durable text and binary bodies", async (t) => {
    const originalTtl = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "0";
    t.after(() => {
        if (originalTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = originalTtl;
    });
    const cases: Array<{ name: string; stored: Record<string, string>; response: Record<string, string>; reuse: boolean }> = [
        { name: "strong to strong", stored: { etag: '"v1"' }, response: { etag: '"v1"' }, reuse: true },
        { name: "weak to weak", stored: { etag: 'W/"v1"' }, response: { etag: 'W/"v1"' }, reuse: true },
        { name: "strong to weak", stored: { etag: '"v1"' }, response: { etag: 'W/"v1"' }, reuse: true },
        { name: "weak to strong", stored: { etag: 'W/"v1"' }, response: { etag: '"v1"' }, reuse: false },
        { name: "different tag", stored: { etag: '"v1"' }, response: { etag: '"v2"' }, reuse: false },
        { name: "missing tag", stored: { etag: '"v1"' }, response: {}, reuse: false },
        { name: "malformed tag", stored: { etag: '"v1"' }, response: { etag: "v1" }, reuse: false },
        { name: "same modification date", stored: { "last-modified": "Tue, 15 Nov 1994 12:45:26 GMT" }, response: { "last-modified": "Tue, 15 Nov 1994 12:45:26 GMT" }, reuse: true },
        { name: "different modification date", stored: { "last-modified": "Tue, 15 Nov 1994 12:45:26 GMT" }, response: { "last-modified": "Wed, 16 Nov 1994 12:45:26 GMT" }, reuse: false },
    ];
    for (const binary of [false, true]) {
        for (const specimen of cases) {
            await t.test(`{§http-manifest} ${binary ? "binary" : "text"}: ${specimen.name}`, async (t) => {
                const db = await openMigrated();
                t.after(() => db.close());
                const requests: Array<{ etag: string | undefined; modified: string | undefined }> = [];
                const first = binary ? Buffer.from([0x00, 0xff, 0x11]) : Buffer.from("original bytes");
                const replacement = binary ? Buffer.from([0x00, 0xfe, 0x22]) : Buffer.from("replacement bytes");
                const server = createServer((request, response) => {
                    if (request.url !== "/representation") {
                        response.writeHead(404).end();
                        return;
                    }
                    requests.push({ etag: request.headers["if-none-match"], modified: request.headers["if-modified-since"] });
                    if (requests.length === 2) {
                        response.writeHead(304, { ...specimen.response, "x-validation": "accepted" }).end();
                        return;
                    }
                    response.writeHead(200, {
                        "content-type": binary ? "application/octet-stream" : "text/plain",
                        ...(requests.length === 1 ? specimen.stored : { etag: '"replacement"' }),
                    }).end(requests.length === 1 ? first : replacement);
                });
                server.listen(0, "127.0.0.1");
                await once(server, "listening");
                t.after(() => {
                    server.closeAllConnections();
                    return new Promise<void>((settle, reject) => server.close((error) => error ? reject(error) : settle()));
                });
                const address = server.address();
                assert.ok(address !== null && typeof address !== "string");
                const authority = `127.0.0.1:${address.port}`;
                const workspaceId = await insertWorkspace(db, `http-validators-${crypto.randomUUID()}`);
                const sessionId = await insertSession(db, workspaceId);
                const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
                const stored = await makeHandlerCtx(ctx, { ...Http.manifest, name: "http" }, authority);
                const http = new Http();
                const read = parsedRead(`http://${authority}/representation`);
                for (const expected of [first, specimen.reuse ? first : replacement]) {
                    const result = await readHttp(http, read, ctx);
                    assert.equal(result.status, 200, JSON.stringify(result));
                    assert.ok(result.content !== null && result.content.length > 0, "the ordinary READ returns the text or hex projection");
                    const entry = (await stored.entries.read("/representation")).entry;
                    assert.ok(entry);
                    assert.deepEqual(Buffer.from(entry.channels.body.content, binary ? "base64" : "utf8"), expected);
                    assert.equal(entry.channels.body.state, "static");
                }
                assert.deepEqual(requests, [
                    { etag: undefined, modified: undefined },
                    { etag: specimen.stored.etag, modified: specimen.stored["last-modified"] },
                    ...(specimen.reuse ? [] : [{ etag: undefined, modified: undefined }]),
                ]);
                const header = (await stored.entries.read("/representation")).entry!.channels.header.content;
                assert.equal(/^x-validation: accepted$/m.test(header), specimen.reuse,
                    "only a corresponding 304 may update the stored representation's metadata");
                if (!specimen.reuse) assert.match(header, /^etag: "replacement"$/m);
            });
        }
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
            if (requestUrl(_url).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            requests += 1;
            if (requests === 1) {
                return new Response("plain body v1", {
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
            return new Response("plain body v2", {
                status: 200,
                headers: { "content-type": "text/plain", etag: 'W/"opaque-2"' },
            });
        };

        const workspaceId = await insertWorkspace(db, `http-mismatch-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });

        const acquired = await readHttp(http, plainTextStatement(), ctx);
        assert.equal(acquired.status, 200);
        assert.equal(acquired.content, "plain body v1");

        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "0";
        const refreshed = await readHttp(http, plainTextStatement(), ctx);
        assert.equal(refreshed.status, 200, "a genuine etag mismatch reacquires unconditionally instead of surfacing an unrecoverable 502");
        assert.equal(refreshed.content, "plain body v2");
        assert.equal(requests, 3, "conditional revalidation, mismatch, one unconditional fallback");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = originalTtl;
        await db.close();
    }
});
});

