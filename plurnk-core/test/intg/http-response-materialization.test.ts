// Composed HTTP response representation coverage {§http-lifecycle}: direct
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

const statement = (lineMarker: ReadStatement["lineMarker"] = null): ReadStatement => {
    const target: UrlPath = {
        kind: "url",
        raw: "https://93.184.216.34/logo.png",
        scheme: "https",
        username: null,
        password: null,
        hostname: "93.184.216.34",
        port: null,
        pathname: "/logo.png",
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
