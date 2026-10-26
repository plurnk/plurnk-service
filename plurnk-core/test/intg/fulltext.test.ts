// {§find-fulltext-selection} {§persistent-search-index} {§find-scoped-isolation}
import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Session from "../../src/schemes/Session.ts";
import Workspace from "../../src/schemes/Workspace.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertSession } from "./_db.ts";
import { makeSchemeCtx } from "./_scheme.ts";
import { matchLocations, resourcePaths } from "./_find.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const edit = (pathname: string, body: string, lineMarker: LineMarker | null = null): ResolvedEditStatement => ({
    metadata: null, op: "EDIT", aside: null, target: url(pathname), lineMarker, body,
    matcher: null, position: { line: 1, column: 1 },
});
const find = (pathname: string, query: string, marks: LineMarker["marks"] = [1, -1]): FindStatement => ({
    metadata: null, op: "FIND", aside: null, target: url(pathname),
    lineMarker: { marks }, matcher: { dialect: "fts", raw: `~${query}` }, body: null,
    position: { line: 1, column: 1 },
});

test("{§find-fulltext-selection} native FTS5 expressions select visible resources and integer result pages", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        for (const [path, body] of [
            ["a.txt", "connection reset retry"],
            ["b.txt", "connection refused retrying"],
            ["c.txt", "the birthday cake"],
        ]) assert.equal((await session.edit(edit(path, body), ctx)).status, 201);
        await SearchIndex.maintain(ctx);
        for (const [query, paths] of [
            ['"connection reset"', ["a.txt"]],
            ["connection NOT reset", ["b.txt"]],
            ["reset OR cake", ["a.txt", "c.txt"]],
            ["connection AND retry*", ["a.txt", "b.txt"]],
            ["NEAR(connection reset, 2)", ["a.txt"]],
        ] as const) {
            const result = await session.find(find("*", query), ctx);
            assert.equal(result.status, 200, query);
            assert.deepEqual(resourcePaths(result).toSorted(), paths.map((path) => `workspace:///${path}`), query);
        }
        const complete = await session.find(find("*", "connection"), ctx);
        const page = await session.find(find("*", "connection", [2]), ctx);
        assert.deepEqual(resourcePaths(page), resourcePaths(complete).slice(1, 2));
        assert.equal((await session.find(find("a.txt", "cake"), ctx)).status, 204);

        const otherWorkspace = await insertWorkspace(db, `fts-other-${crypto.randomUUID()}`);
        const otherSession = await insertSession(db, otherWorkspace);
        const other = makeSchemeCtx({ db, workspaceId: otherWorkspace, sessionId: otherSession });
        await session.edit(edit("private.txt", "connection reset retry"), other);
        await SearchIndex.maintain(other);
        assert.deepEqual(resourcePaths(await session.find(find("*", '"connection reset"'), ctx)), ["workspace:///a.txt"]);
        assert.deepEqual(
            await db.test_inference_calls_by_workspace.all({ workspace_id: workspaceId }),
            [],
            "source processing and FTS5 queries create no inference calls",
        );
    } finally { await db.close(); }
});

test("{§find-fulltext-selection} FTS5 locations preserve Unicode columns, line endings and multi-line phrases", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-coordinates-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        await session.edit(edit("text.txt", "😀 café\r\nconnection\nreset\r\n\u001f[ retry \u001f]"), ctx);
        await SearchIndex.maintain(ctx);
        const accented = await session.find(find("text.txt", "cafe"), ctx);
        assert.equal(accented.status, 200);
        assert.deepEqual(matchLocations(accented).map(({ matched, region }) => ({ matched, region })), [
            { matched: "café", region: { startLine: 1, startColumn: 3, endLine: 1, endColumn: 7 } },
        ]);
        const phrase = await session.find(find("text.txt", '"connection reset"'), ctx);
        assert.equal(phrase.status, 200);
        assert.deepEqual(matchLocations(phrase).map(({ matched, region }) => ({ matched, region })), [
            { matched: "connection\nreset", region: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 6 } },
        ]);
        const collision = await session.find(find("text.txt", "retry"), ctx);
        assert.equal(collision.status, 200);
        assert.deepEqual(matchLocations(collision).map(({ matched }) => matched), ["retry"]);
    } finally { await db.close(); }
});

test("{§find-fulltext-selection} FTS5 reindexing replaces old terms, uses complete bodies and preserves stable ties", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-freshness-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        await session.edit(edit("b.txt", "same search terms"), ctx);
        await session.edit(edit("a.txt", "same search terms"), ctx);
        await session.edit(edit("deep.txt", "filler\n".repeat(2000) + "lateuniqueword"), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(resourcePaths(await session.find(find("*", "same"), ctx)), ["workspace:///a.txt", "workspace:///b.txt"]);
        assert.deepEqual(resourcePaths(await session.find(find("*", "lateuniqueword"), ctx)), ["workspace:///deep.txt"]);
        await session.edit(edit("a.txt", "replacement", { marks: [1, -1] }), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(resourcePaths(await session.find(find("*", "same"), ctx)), ["workspace:///b.txt"]);
        assert.deepEqual(resourcePaths(await session.find(find("*", "replacement"), ctx)), ["workspace:///a.txt"]);
    } finally { await db.close(); }
});

test("{§find-fulltext-selection} malformed native FTS5 queries return their parser diagnostic without guessing intent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-invalid-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        await session.edit(edit("text.txt", "example"), ctx);
        await SearchIndex.maintain(ctx);
        for (const [query, diagnostic] of [
            ['"unterminated', "unterminated string"],
            ["missing:word", "no such column: missing"],
            ["AND", 'fts5: syntax error near "AND"'],
            ["NEAR(example, xx)", 'expected integer, got "xx"'],
        ]) {
            const result = await session.find(find("*", query), ctx);
            assert.equal(result.status, 400, query);
            assert.equal(result.problem?.diagnostic, diagnostic);
            assert.equal(result.problem?.dialect, "fts");
            assert.deepEqual(result.results, []);
        }
    } finally { await db.close(); }
});

// The recorded shape (#853): `FIND (doc/**) ~inherited-members` leaked "no such column: members".
test("{§fts-word-phrase}: a word with inner punctuation searches its tokens as a phrase", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-phrase-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        for (const [path, body] of [
            ["autodoc.rst", "The :inherited-members: option documents inherited members."],
            ["other.rst", "members inherited from a base, in the other order"],
            ["cpp.rst", "Parsers for c++ and x.y paths under a/b."],
        ]) assert.equal((await session.edit(edit(path, body), ctx)).status, 201);
        await SearchIndex.maintain(ctx);
        for (const [query, paths] of [
            ["inherited-members", ["autodoc.rst"]],
            ["inherited-members AND option", ["autodoc.rst"]],
            ["c++", ["cpp.rst"]],
            ["x.y OR a/b", ["cpp.rst"]],
            ["^parsers-for*", ["cpp.rst"]],
        ] as const) {
            const result = await session.find(find("*", query), ctx);
            assert.equal(result.status, 200, `${query}: ${JSON.stringify(result.problem)}`);
            assert.deepEqual(resourcePaths(result).toSorted(), paths.map((path) => `workspace:///${path}`), query);
        }
        const excluded = await session.find(find("*", "inherited -members"), ctx);
        assert.equal(excluded.status, 400, "a leading `-` stays FTS5's column exclusion");
        assert.equal(excluded.problem?.recovery, "An FTS5 query is barewords, \"quoted phrases\", and AND, OR, NOT and NEAR between them."); // {§diagnostic-observation}
    } finally { await db.close(); }
});

test("{§find-fulltext-selection} FTS5 uses native BM25 relevance before the identity tie-breaker", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-rank-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        await session.edit(edit("a.txt", "needle " + "irrelevant ".repeat(100)), ctx);
        await session.edit(edit("z.txt", "needle needle"), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(resourcePaths(await session.find(find("*", "needle"), ctx)), ["workspace:///z.txt", "workspace:///a.txt"]);
        assert.deepEqual(resourcePaths(await session.find(find("*", "needle", [1]), ctx)), ["workspace:///z.txt"]);
    } finally { await db.close(); }
});

test("{§find-fulltext-selection} FTS5 respects literal namespaces and removes deleted targets from every observer's results", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-owner-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "first");
        const siblingId = await insertSession(db, workspaceId, null, "second");
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const sibling = makeSchemeCtx({ db, workspaceId, sessionId: siblingId });
        const workspace = new Workspace();
        const session = new Session();
        const owned = { ...url("note.txt"), scheme: "session", raw: "session://first/note.txt", hostname: "first" };
        const second = { ...url("note.txt"), scheme: "session", raw: "session://second/note.txt", hostname: "second" };
        await workspace.edit(edit("note.txt", "commonsneedle"), ctx);
        await session.edit({ ...edit("note.txt", "firstneedle"), target: owned }, ctx);
        await session.edit({ ...edit("note.txt", "secondneedle"), target: second }, sibling);
        await SearchIndex.maintain(ctx);
        const query = "commonsneedle OR firstneedle OR secondneedle";
        assert.deepEqual(resourcePaths(await workspace.find(find("*", query), ctx)), ["workspace:///note.txt"]);
        const ownFind = { ...find("*", query), target: { ...url("*"), scheme: "session", raw: "session://first/*", hostname: "first" } };
        assert.deepEqual(resourcePaths(await session.find(ownFind, ctx)), ["session://first/note.txt"]);
        assert.deepEqual(resourcePaths(await session.find(ownFind, sibling)), ["session://first/note.txt"]);
        assert.equal((await session.find({ ...ownFind, matcher: { dialect: "fts", raw: "~secondneedle" } }, ctx)).status, 204);
        assert.equal((await session.killEntry({
            ...find("note.txt", query), op: "KILL", target: owned, matcher: null, body: null, lineMarker: null,
        }, ctx)).status, 200);
        await SearchIndex.maintain(ctx);
        assert.equal((await session.find(ownFind, ctx)).status, 204);
        assert.equal((await session.find(ownFind, sibling)).status, 204);
        assert.deepEqual(resourcePaths(await session.find({ ...ownFind, target: { ...ownFind.target, hostname: "second", raw: "session://second/*" } }, ctx)), ["session://second/note.txt"], "the independent namespace is preserved");
        assert.deepEqual(resourcePaths(await workspace.find(find("*", query), ctx)), ["workspace:///note.txt"], "the commons remain independent");
    } finally { await db.close(); }
});
