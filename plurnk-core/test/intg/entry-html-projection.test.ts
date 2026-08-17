// Web-page projection is scoped to the WEB-FETCH entry point (the exec sink), NOT generic writes.
// A fetched html page stores the handler's readable projection as the decisive `body`
// (text/markdown — what READ serves and every price reports) with the raw page under `html`
// (xpath + archive). An AUTHORED/workspace html file is DATA — written verbatim, attributes intact,
// so a default READ still sees a `<user email=…>` roster (the regression the email story caught).

import test from "node:test";
import assert from "node:assert/strict";
import type { ReadStatement, ExecStatement } from "@plurnk/plurnk-contracts";
import Http from "@plurnk/plurnk-schemes-http";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import EntryOps from "../../src/schemes/_entry-ops.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, lookThroughScheme, makeSchemeCtx, testExecutors, DEFAULT_MIMETYPES, quiesceExecs } from "./_helpers.ts";

const ROSTER = "<html><body><h1>Team Roster</h1><user email=\"alice@x.com\">Alice</user></body></html>";

const readStmt = (pathname: string, body: ReadStatement["body"] = null): ReadStatement => ({
    op: "READ", annotation: null, delimiter: "", signal: null,
    target: { kind: "url", raw: `worker:///${pathname}`, scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: `/${pathname}`, query: null, fragment: null },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

test("an AUTHORED html write is verbatim — attribute data survives a default READ (the email regression)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `authored-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4) });

        const written = await EntryCrud.writeEntry("/roster.html", { channels: { body: { content: ROSTER, mimetype: "text/html" } } }, ctx, "worker");
        assert.equal(written.status, 201);
        const rows = await db.entry_read_channels.all<{ name: string; content: string; mimetype: string }>({ entry_id: written.entryId });
        assert.deepEqual(rows.map((r) => r.name), ["body"], "one verbatim channel — no projection, no #html sibling");
        assert.equal(rows[0].mimetype, "text/html", "the authored mimetype is preserved");

        const read = await EntryOps.readWorkspaceEntry(readStmt("roster.html"), ctx, Worker.manifest);
        assert.match(read.content ?? "", /alice@x\.com/, "a default READ sees the email — attributes intact");
    } finally { await db.close(); }
});

test("a FETCHED html page (via the exec sink) projects: decisive markdown body + raw #html archive", async () => {
    const rawHtml = `<html><head><script>ads()</script></head><body><h1>Headline</h1><p>${"the body text remains readable ".repeat(20)}</p></body></html>`;
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    engine.registerRuntime("fetchstub", {
        executor: {
            runtime: "fetchstub", glyph: "?",
            get manifest() { return { name: "fetchstub", channels: { results: "text/html" }, defaultChannel: "results", category: "data", writableBy: ["plugin"], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "text/html" } }; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run: async (args: { entry?: (p: string, c: string, o: object) => Promise<void>; write: (c: string, x: string, m: string) => void; setState: (c: string, s: string) => void }) => {
                await args.entry?.("https://news.example/a", rawHtml, { tags: ["q"], mimetype: "text/html" });
                args.write("results", "[]", "application/json");
                args.setState("results", "closed");
                return { status: 200, exitCode: 0 };
            },
        },
        namespaceOwner: { kind: "module", name: "fetchstub fixture" },
        glyph: "?", summary: "HTML projection fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } }, details: "", available: true, detail: undefined,
    } as never);
    try {
        const workspaceId = await insertWorkspace(db, `fetched-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "fetch test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await engine.dispatch({ statement: { op: "EXEC", annotation: null, delimiter: "", signal: "fetchstub", target: null, lineMarker: null, body: "go", position: { line: 1, column: 1 } } as ExecStatement, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await quiesceExecs(schemes); // {§exec-entry-sink}: settle materialization before db.close().

        const entry = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/news.example/a" });
        assert.ok(entry !== undefined, "the fetched page materialized");
        const rows = await db.entry_read_channels.all<{ name: string; content: string; mimetype: string; weight: number }>({ entry_id: entry.id });
        const byName = new Map(rows.map((r) => [r.name, r]));
        assert.equal(byName.get("body")?.mimetype, "text/markdown", "the decisive body is the projection");
        assert.match(byName.get("body")!.content, /Headline/, "the readable text survives");
        assert.ok(!byName.get("body")!.content.includes("<script>"), "the markup does not");
        assert.ok(
            byName.get("body")!.content.split("\n").every((line) => line.length <= 100),
            "the decisive Markdown projection has bounded prose lines",
        );
        assert.equal(byName.get("html")?.content, rawHtml, "the raw #html archive remains byte-for-byte faithful");
        assert.ok(byName.get("body")!.weight < byName.get("html")!.weight, "the curation weight is the projection's, not the scaffolding's");
    } finally { await quiesceExecs(schemes); await db.close(); }
});

test("a scoped HTTP READ slices the materialized readable body instead of starting another fetch", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `http-scope-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await EntryCrud.writeEntry("/example.org/page", {
            channels: {
                body: { content: "one\ntwo\nthree\nfour", mimetype: "text/markdown" },
                header: { content: "HTTP 200 OK", mimetype: "text/plain" },
                html: { content: "<p>one</p><p>two</p><p>three</p><p>four</p>", mimetype: "text/html" },
            },
        }, ctx, "https");
        const statement: ReadStatement = {
            op: "READ", annotation: null, delimiter: "", signal: null,
            target: {
                kind: "url", raw: "https://example.org/page", scheme: "https",
                username: null, password: null, hostname: "example.org", port: null,
                pathname: "/page", query: null, fragment: null,
            },
            lineMarker: { marks: [2, 3] }, body: null, position: { line: 1, column: 1 },
        };
        const result = await lookThroughScheme("http", new Http(), statement, ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "two\nthree");
        assert.equal(result.startLine, 2);
    } finally { await db.close(); }
});

test("a scoped HTTP READ slices the selected auxiliary channel when body is empty", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `http-header-scope-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await EntryCrud.writeEntry("/example.org/empty", {
            channels: {
                body: { content: "", mimetype: "text/plain" },
                header: {
                    content: "HTTP 204 No Content\ncontent-type: text/plain\nx-request-id: 42",
                    mimetype: "text/plain",
                },
            },
        }, ctx, "https");
        const statement: ReadStatement = {
            op: "READ", annotation: null, delimiter: "", signal: null,
            target: {
                kind: "url", raw: "https://example.org/empty#header", scheme: "https",
                username: null, password: null, hostname: "example.org", port: null,
                pathname: "/empty", query: null, fragment: "header",
            },
            lineMarker: { marks: [2, 3] }, body: null, position: { line: 1, column: 1 },
        };
        const result = await lookThroughScheme("http", new Http(), statement, ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "content-type: text/plain\nx-request-id: 42");
        assert.equal(result.channel, "header");
        assert.equal(result.startLine, 2);
    } finally { await db.close(); }
});
