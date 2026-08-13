// {§graph-relations} FIND graph dialect over symbol_defs/symbol_refs.
//   @<sym  referrers — entries that REFERENCE sym
//   @>sym  referents — entries DEFINING what sym references
//   @sym   neighborhood — def ∪ referrers ∪ referents
// Symbol rows derive from mimetype symbols/references during persistent-index
// maintenance. Source resolution is workspace-wide; the authored target
// constrains the returned resources.

import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, LineMarker, MatcherBody, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, DEFAULT_MIMETYPES, mimetypesFixture } from "./_helpers.ts";
import { resourceGroups, resourcePaths } from "./_find.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): ResolvedEditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: marker, body,
    position: { line: 1, column: 1 },
});

const findStmt = (target: UrlPath, body: MatcherBody): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const graph = (raw: string): MatcherBody => ({ dialect: "graph", raw });

// a.ts defines foo (whose body calls bar); b.ts references foo; c.ts defines bar.
// So: foo's referrers = {b.ts}, foo's referents = {c.ts} (via its call to bar).
const FILES: ReadonlyArray<readonly [string, string]> = [
    ["a.ts", "export function foo() {\n  bar();\n}\n"],
    ["b.ts", "import { foo } from \"./a\";\nfoo();\n"],
    ["c.ts", "export function bar() {}\n"],
];

const seed = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `graph-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const k = new Worker();
    for (const [pathname, body] of FILES) {
        await k.edit(editStmt(url(pathname), body), makeSchemeCtx({ db, workspaceId, workerId }));
    }
    // The pre-model persistent-index pass derives graph artifacts from every
    // readable entry. {§persistent-search-index}
    await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId }));
    return { db, workspaceId, workerId };
};

const find = (db: import("../../src/core/Db.ts").Db, workspaceId: number, workerId: number, raw: string) =>
    new Worker().find(findStmt(url(""), graph(raw)), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));

test("graph FIND reports an incomplete persistent index instead of silently dropping entries", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `graph-readiness-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(editStmt(url("pending.ts"), "export function pending() {}\n"), ctx);

        const result = await find(db, workspaceId, workerId, "@pending");

        assert.equal(result.status, 503);
        assert.deepEqual(result.problem?.search, {
            state: "incomplete",
            indexed: 0,
            total: 1,
        });
    } finally { db.close(); }
});

test("@<foo finds entries that reference foo, not the definer", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        const r = await find(db, workspaceId, workerId, "@<foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["worker:///b.ts"]);
        assert.equal(resourceGroups(r)[0]?.[0].matchLocationCount, 2, "the broad row counts the import and call locations");
        assert.equal(r.matchLocationCount, 2);
    } finally { db.close(); }
});

test("@>foo finds entries defining what foo references", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        const r = await find(db, workspaceId, workerId, "@>foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["worker:///c.ts"]);
    } finally { db.close(); }
});

test("@foo is the union of definitions, referrers, and referents", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        const r = await find(db, workspaceId, workerId, "@foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["worker:///a.ts", "worker:///b.ts", "worker:///c.ts"]);
    } finally { db.close(); }
});

test("{§range-extent}: a graph matcher selecting no resources returns 204 with its empty extent", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        const r = await find(db, workspaceId, workerId, "@<nope");
        assert.deepEqual(r, {
            status: 204,
            content: null,
            mimetype: null,
            results: [],
            itemsTokenTotal: 0,
            returnedItemsTokenTotal: 0,
            matchingPathCount: 0,
            matchLocationCount: 0,
            range: {
                unit: "resource",
                total: 0,
                requested: [1, 16],
            },
        });
    } finally { db.close(); }
});

test("editing foo's referrer away drops it from @<foo after index maintenance", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        // b.ts no longer references foo — re-deriving its rows must remove the edge.
        await new Worker().edit(editStmt(url("b.ts"), "export const x = 1;\n", fullReplace), makeSchemeCtx({ db, workspaceId, workerId }));
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await find(db, workspaceId, workerId, "@<foo");
        assert.equal(r.status, 204);
        assert.deepEqual([...new Set(resourcePaths(r))], []);
    } finally { db.close(); }
});

test("persistent-index maintenance re-derives only on content change", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `gate-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(editStmt(url("a.ts"), "export function foo() {}\n"), ctx);

        // Fresh counting wrapper — never mutate the shared DEFAULT_MIMETYPES (intg
        // runs concurrently). Counts only the symbols+references parse.
        let parses = 0;
        const counting = mimetypesFixture({
            process: (...args: Parameters<typeof DEFAULT_MIMETYPES.process>) => {
                if (args[1]?.channels?.includes("symbols")) parses++;
                return DEFAULT_MIMETYPES.process(...args);
            },
        });
        const gctx = { ...ctx, mimetypes: counting };

        await SearchIndex.maintain(gctx);
        assert.equal(parses, 1, "first sight: content unseen → derive");
        await SearchIndex.maintain(gctx);
        assert.equal(parses, 1, "unchanged: deep_hash matches → skip the parse");

        await new Worker().edit(editStmt(url("a.ts"), "export function bar() {}\n", fullReplace), ctx);
        await SearchIndex.maintain(gctx);
        assert.equal(parses, 2, "content changed → re-derive");
    } finally { db.close(); }
});
