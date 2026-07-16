// Web-page projection is scoped to the WEB-FETCH entry point (the exec sink), NOT generic writes.
// A fetched html page stores the handler's readable projection as the decisive `body`
// (text/markdown — what READ serves and every price reports) with the raw page under `html`
// (xpath + archive). An AUTHORED/workspace html file is DATA — written verbatim, attributes intact,
// so a default READ still sees a `<user email=…>` roster (the regression the email story caught).

import test from "node:test";
import assert from "node:assert/strict";
import type { ReadStatement, ExecStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import EntryOps from "../../src/schemes/_entry-ops.ts";
import Known from "../../src/schemes/Known.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, testExecutors, DEFAULT_MIMETYPES, quiesceExecs } from "./_helpers.ts";

const ROSTER = "<html><body><h1>Team Roster</h1><user email=\"alice@x.com\">Alice</user></body></html>";

const readStmt = (pathname: string, body: ReadStatement["body"] = null): ReadStatement => ({
    op: "READ", suffix: "", signal: null,
    target: { kind: "url", raw: `known:///${pathname}`, scheme: "known", username: null, password: null, hostname: null, port: null, pathname: `/${pathname}`, params: {}, fragment: null },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

test("an AUTHORED html write is verbatim — attribute data survives a default READ (the email regression)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `authored-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId, mimetypes: DEFAULT_MIMETYPES, tokenize: (t: string) => Math.ceil(t.length / 4) });

        const written = await EntryCrud.writeEntry("/roster.html", { channels: { body: { content: ROSTER, mimetype: "text/html" } }, tags: [] }, ctx, "known");
        assert.equal(written.status, 201);
        const rows = await (db.entry_read_channels as PrepMethod).all<{ name: string; content: string; mimetype: string }>({ entry_id: written.entryId });
        assert.deepEqual(rows.map((r) => r.name), ["body"], "one verbatim channel — no projection, no #html sibling");
        assert.equal(rows[0].mimetype, "text/html", "the authored mimetype is preserved");

        const read = await EntryOps.readWorkspaceEntry(readStmt("roster.html"), ctx, Known.manifest);
        assert.match(read.content ?? "", /alice@x\.com/, "a default READ sees the email — attributes intact");
    } finally { await db.close(); }
});

test("a FETCHED html page (via the exec sink) projects: decisive markdown body + raw #html archive", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    engine.hotloadRuntime("fetchstub", {
        executor: {
            runtime: "fetchstub", glyph: "?",
            get manifest() { return { name: "fetchstub", protocol: "fetchstub:", channels: {}, defaultChannel: "results", category: "action", scope: "worker", writableBy: ["model"], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return {}; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run: async (args: { entry?: (p: string, c: string, o: object) => Promise<void>; write: (c: string, x: string, m: string) => void; setState: (c: string, s: string) => void }) => {
                await args.entry?.("https://news.example/a", "<html><head><script>ads()</script></head><body><h1>Headline</h1><p>the body text</p></body></html>", { tags: ["q"], mimetype: "text/html" });
                args.write("results", "[]", "application/json");
                args.setState("results", "closed");
                return { status: 200, exitCode: 0 };
            },
        },
        glyph: "?", example: "", documentation: "", available: true, detail: undefined,
    } as never);
    try {
        const workspaceId = await insertWorkspace(db, `fetched-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "fetch test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await engine.dispatch({ statement: { op: "EXEC", suffix: "", signal: "fetchstub", target: null, lineMarker: null, body: "go", position: { line: 1, column: 1 } } as ExecStatement, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await quiesceExecs(schemes); // drains the fetch spawn's tail + entry() write — no race with db.close (#432)

        const entry = await (db.test_entries_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "/news.example/a" });
        assert.ok(entry !== undefined, "the fetched page materialized");
        const rows = await (db.entry_read_channels as PrepMethod).all<{ name: string; content: string; mimetype: string; tokens: number }>({ entry_id: entry.id });
        const byName = new Map(rows.map((r) => [r.name, r]));
        assert.equal(byName.get("body")?.mimetype, "text/markdown", "the decisive body is the projection");
        assert.match(byName.get("body")!.content, /Headline/, "the readable text survives");
        assert.ok(!byName.get("body")!.content.includes("<script>"), "the markup does not");
        assert.match(byName.get("html")?.content ?? "", /<script>ads\(\)/, "the raw page is archived under #html for xpath");
        assert.ok(byName.get("body")!.tokens < byName.get("html")!.tokens, "the price is the projection's, not the scaffolding's");
    } finally { await quiesceExecs(schemes); await db.close(); }
});
