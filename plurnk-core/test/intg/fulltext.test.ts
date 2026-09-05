// {§find-fulltext-selection} {§persistent-search-index} {§find-scoped-isolation}
import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";
import { matchLocations, resourceGroups, resourcePaths } from "./_find.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const edit = (pathname: string, body: string, lineMarker: LineMarker | null = null): ResolvedEditStatement => ({
    metadata: null, op: "EDIT", annotation: null, delimiter: "", target: url(pathname), lineMarker, body,
    position: { line: 1, column: 1 },
});
const find = (pathname: string, query: string, marks: LineMarker["marks"] = [1, -1]): FindStatement => ({
    metadata: null, op: "FIND", annotation: null, delimiter: "", target: url(pathname),
    lineMarker: { marks }, body: { dialect: "fts", raw: `~${query}` },
    position: { line: 1, column: 1 },
});

test("native FTS5 expressions select visible resources and integer result pages", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const worker = new Worker();
        for (const [path, body] of [
            ["a.txt", "connection reset retry"],
            ["b.txt", "connection refused retrying"],
            ["c.txt", "the birthday cake"],
        ]) assert.equal((await worker.edit(edit(path, body), ctx)).status, 201);
        await SearchIndex.maintain(ctx);
        for (const [query, paths] of [
            ['"connection reset"', ["a.txt"]],
            ["connection NOT reset", ["b.txt"]],
            ["reset OR cake", ["a.txt", "c.txt"]],
            ["connection AND retry*", ["a.txt", "b.txt"]],
            ["NEAR(connection reset, 2)", ["a.txt"]],
        ] as const) {
            const result = await worker.find(find("*", query), ctx);
            assert.equal(result.status, 200, query);
            assert.deepEqual(resourcePaths(result).sort(), paths.map((path) => `worker:///${path}`), query);
            assert.ok(resourceGroups(result).every(([row]) => !Object.hasOwn(row, "similarity")));
        }
        const complete = await worker.find(find("*", "connection"), ctx);
        const page = await worker.find(find("*", "connection", [2]), ctx);
        assert.deepEqual(resourcePaths(page), resourcePaths(complete).slice(1, 2));
        assert.equal((await worker.find(find("*", "connection", [0.8]), ctx)).status, 416);
        assert.equal((await worker.find(find("a.txt", "cake"), ctx)).status, 204);

        const otherWorkspace = await insertWorkspace(db, `fts-other-${crypto.randomUUID()}`);
        const otherWorker = await insertWorker(db, otherWorkspace);
        const other = makeSchemeCtx({ db, workspaceId: otherWorkspace, workerId: otherWorker });
        await worker.edit(edit("private.txt", "connection reset retry"), other);
        await SearchIndex.maintain(other);
        assert.deepEqual(resourcePaths(await worker.find(find("*", '"connection reset"'), ctx)), ["worker:///a.txt"]);
        assert.deepEqual(
            await db.test_inference_calls_by_workspace.all({ workspace_id: workspaceId }),
            [],
            "source processing and FTS5 queries create no inference calls",
        );
    } finally { await db.close(); }
});

test("FTS5 locations preserve Unicode columns, line endings and multi-line phrases", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-coordinates-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const worker = new Worker();
        await worker.edit(edit("text.txt", "😀 café\r\nconnection\nreset\r\n\u001f[ retry \u001f]"), ctx);
        await SearchIndex.maintain(ctx);
        const accented = await worker.find(find("text.txt", "cafe"), ctx);
        assert.equal(accented.status, 200);
        assert.deepEqual(matchLocations(accented).map(({ matched, region }) => ({ matched, region })), [
            { matched: "café", region: { startLine: 1, startColumn: 3, endLine: 1, endColumn: 7 } },
        ]);
        const phrase = await worker.find(find("text.txt", '"connection reset"'), ctx);
        assert.equal(phrase.status, 200);
        assert.deepEqual(matchLocations(phrase).map(({ matched, region }) => ({ matched, region })), [
            { matched: "connection\nreset", region: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 6 } },
        ]);
        const collision = await worker.find(find("text.txt", "retry"), ctx);
        assert.equal(collision.status, 200);
        assert.deepEqual(matchLocations(collision).map(({ matched }) => matched), ["retry"]);
    } finally { await db.close(); }
});

test("FTS5 reindexing replaces old terms, uses complete bodies and preserves stable ties", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-freshness-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const worker = new Worker();
        await worker.edit(edit("b.txt", "same search terms"), ctx);
        await worker.edit(edit("a.txt", "same search terms"), ctx);
        await worker.edit(edit("deep.txt", "filler\n".repeat(2000) + "lateuniqueword"), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(resourcePaths(await worker.find(find("*", "same"), ctx)), ["worker:///a.txt", "worker:///b.txt"]);
        assert.deepEqual(resourcePaths(await worker.find(find("*", "lateuniqueword"), ctx)), ["worker:///deep.txt"]);
        await worker.edit(edit("a.txt", "replacement", { marks: [1, -1] }), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(resourcePaths(await worker.find(find("*", "same"), ctx)), ["worker:///b.txt"]);
        assert.deepEqual(resourcePaths(await worker.find(find("*", "replacement"), ctx)), ["worker:///a.txt"]);
    } finally { await db.close(); }
});

test("malformed native FTS5 queries return their parser diagnostic without guessing intent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-invalid-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const worker = new Worker();
        await worker.edit(edit("text.txt", "example"), ctx);
        await SearchIndex.maintain(ctx);
        for (const [query, diagnostic] of [
            ['"unterminated', "unterminated string"],
            ["missing:word", "no such column: missing"],
            ["AND", 'fts5: syntax error near "AND"'],
            ["NEAR(example, xx)", 'expected integer, got "xx"'],
        ]) {
            const result = await worker.find(find("*", query), ctx);
            assert.equal(result.status, 400, query);
            assert.equal(result.problem?.diagnostic, diagnostic);
            assert.equal(result.problem?.dialect, "fts");
            assert.deepEqual(result.results, []);
        }
    } finally { await db.close(); }
});

test("FTS5 uses native BM25 relevance before the identity tie-breaker", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-rank-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const worker = new Worker();
        await worker.edit(edit("a.txt", "needle " + "irrelevant ".repeat(100)), ctx);
        await worker.edit(edit("z.txt", "needle needle"), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(resourcePaths(await worker.find(find("*", "needle"), ctx)), ["worker:///z.txt", "worker:///a.txt"]);
        assert.deepEqual(resourcePaths(await worker.find(find("*", "needle", [1]), ctx)), ["worker:///z.txt"]);
    } finally { await db.close(); }
});

test("FTS5 respects resolved worker ownership and removes deleted targets from results", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-owner-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "first");
        const siblingId = await insertWorker(db, workspaceId, null, "second");
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const sibling = makeSchemeCtx({ db, workspaceId, workerId: siblingId });
        const worker = new Worker();
        const owned = { ...url("note.txt"), raw: "worker://~/note.txt", hostname: "~" };
        await worker.edit(edit("note.txt", "commonsneedle"), ctx);
        await worker.edit({ ...edit("note.txt", "firstneedle"), target: owned }, ctx);
        await worker.edit({ ...edit("note.txt", "secondneedle"), target: owned }, sibling);
        await SearchIndex.maintain(ctx);
        const query = "commonsneedle OR firstneedle OR secondneedle";
        assert.deepEqual(resourcePaths(await worker.find(find("*", query), ctx)), ["worker:///note.txt"]);
        const ownFind = { ...find("*", query), target: { ...url("*"), raw: "worker://~/*", hostname: "~" } };
        assert.deepEqual(resourcePaths(await worker.find(ownFind, ctx)), ["worker://~/note.txt"]);
        assert.equal((await worker.find({ ...ownFind, body: { dialect: "fts", raw: "~secondneedle" } }, ctx)).status, 204);
        assert.equal((await worker.killEntry({
            ...find("note.txt", query), op: "KILL", target: owned, body: null, lineMarker: null,
        }, ctx)).status, 200);
        await SearchIndex.maintain(ctx);
        assert.equal((await worker.find(ownFind, ctx)).status, 204);
        assert.deepEqual(resourcePaths(await worker.find(ownFind, sibling)), ["worker://~/note.txt"], "deleting one owner's entry preserves the sibling's");
        assert.deepEqual(resourcePaths(await worker.find(find("*", query), ctx)), ["worker:///note.txt"], "the commons remain independent");
    } finally { await db.close(); }
});
