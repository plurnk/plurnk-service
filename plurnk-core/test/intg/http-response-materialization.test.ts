// Composed HTTP response representation coverage {§http-lifecycle} and
// {§http-text-decoding}: direct
// acquisition writes through real SchemeCtx capabilities to SQLite, then
// universal READ observes the durable marker through the binary boundary.

import test from "node:test";
import assert from "node:assert/strict";
import type { ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Http from "@plurnk/plurnk-schemes-http";
import {
    openMigrated,
    insertWorkspace,
    insertWorker,
    makeSchemeCtx,
    makeHandlerCtx,
} from "./_helpers.ts";

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

test("a direct binary response persists one typed marker whose universal READ is 415", async () => {
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
        const manifest = { ...Http.manifest, name: "https" };

        const acquired = await http.read(statement(), makeHandlerCtx(ctx, manifest));
        assert.equal(acquired.status, 415);
        assert.equal(acquired.problem?.type, "https://problems.plurnk.dev/scheme/http/binary-response-unsupported");

        const entry = await db.test_entries_by_pathname.get<{ id: number; scheme: string }>({
            pathname: "/93.184.216.34/logo.png",
        });
        assert.equal(entry?.scheme, "https");
        const channels = await db.entry_read_channels.all<{
            name: string;
            content: string;
            mimetype: string;
            state: string;
        }>({ entry_id: entry?.id });
        const byName = new Map(channels.map((channel) => [channel.name, channel]));
        assert.equal(byName.get("body")?.content, "");
        assert.equal(byName.get("body")?.mimetype, "image/png");
        assert.equal(byName.get("body")?.state, "errored");
        assert.match(byName.get("header")?.content ?? "", /^HTTP 200 OK/m);

        const reread = await http.read(statement({ marks: [1] }), makeHandlerCtx(ctx, manifest));
        assert.equal(reread.status, 415);
        assert.equal(reread.problem?.type, "https://problems.plurnk.dev/scheme/https/binary-read-unsupported");
        assert.equal(reread.mimetype, "image/png");
    } finally {
        globalThis.fetch = originalFetch;
        await http.close();
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

        assert.equal((await http.read(statement(null, "/paper.pdf"), handlerCtx)).status, 102);
        const entry = await handlerCtx.entries.read("/93.184.216.34/paper.pdf");
        assert.equal(entry.entry?.channels.body.mimetype, "text/markdown");
        assert.match(entry.entry?.channels.body.content ?? "", /Hello, world!/);
        assert.equal(entry.entry?.channels.body.state, "closed");
        assert.match(entry.entry?.channels.header.content ?? "", /^content-type: application\/pdf$/m);
        assert.match(
            entry.entry?.channels.header.content ?? "",
            /^x-plurnk-projection-id: [a-f0-9]{64}$/m,
        );

        const reread = await http.read(statement({ marks: [1] }, "/paper.pdf"), handlerCtx);
        assert.equal(reread.status, 200);
        assert.match(reread.content ?? "", /Hello, world!/);
        assert.equal(reread.mimetype, "text/markdown");
    } finally {
        globalThis.fetch = originalFetch;
        await http.close();
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

        assert.equal((await http.read(legacyTextStatement(), handlerCtx)).status, 102);

        const entry = await handlerCtx.entries.read("/93.184.216.34/legacy.txt");
        assert.equal(entry.entry?.channels.body.content, "caf�");
        assert.equal(entry.entry?.channels.body.mimetype, "text/plain");
        assert.equal(entry.entry?.channels.body.state, "closed");
        assert.match(
            entry.entry?.channels.header.content ?? "",
            /^content-type: text\/plain; charset=windows-1252$/m,
        );
    } finally {
        globalThis.fetch = originalFetch;
        await http.close();
        await db.close();
    }
});

test("an empty direct GET transitions active → closed and remains reusable through 304 and TTL", async () => {
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
                return new Response(null, { status: 304, statusText: "Not Modified" });
            }
            throw new Error("a fresh completed representation must not perform another request");
        };

        const workspaceId = await insertWorkspace(db, `http-empty-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const handlerCtx = makeHandlerCtx(ctx, { ...Http.manifest, name: "https" });
        const pathname = "/93.184.216.34/empty";

        const acquiring = http.read(emptyStatement(), handlerCtx);
        await firstStarted.promise;
        const inFlight = await handlerCtx.entries.read(pathname);
        firstResponse.resolve(new Response(null, {
            status: 204,
            statusText: "No Content",
            headers: { "content-type": "text/plain", etag: '"empty-v1"' },
        }));
        assert.equal(Object.keys(inFlight.entry?.channels ?? {}).length, 3);
        assert.ok(Object.values(inFlight.entry?.channels ?? {}).every(({ state }) => state === "active"));
        assert.equal((await acquiring).status, 102);

        const completed = await handlerCtx.entries.read(pathname);
        assert.equal(completed.entry?.channels.body.content, "");
        assert.equal(Object.keys(completed.entry?.channels ?? {}).length, 3);
        assert.ok(Object.values(completed.entry?.channels ?? {}).every(({ state }) => state === "closed"));

        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "0";
        assert.equal((await http.read(emptyStatement(), handlerCtx)).status, 102);
        assert.equal(requests, 2, "stale empty representation revalidated through 304");
        assert.equal((await handlerCtx.entries.read(pathname)).entry?.channels.body.state, "closed");

        process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "60000";
        assert.equal((await http.read(emptyStatement(), handlerCtx)).status, 102);
        assert.equal(requests, 2, "fresh empty representation used the TTL fast path");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalTtl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = originalTtl;
        await http.close();
        await db.close();
    }
});
