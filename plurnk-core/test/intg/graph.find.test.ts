// @graph (plurnk-service#186) — FIND graph dialect over symbol_defs/symbol_refs.
//   @<sym  referrers — entries that REFERENCE sym
//   @>sym  referents — entries DEFINING what sym references
//   @sym   neighborhood — def ∪ referrers ∪ referents
// Symbol rows derive at the EDIT/write hook (EntryGraph.populate via mimetypes
// symbols+references channels); resolution is name-match across (workspace, scheme).

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, LineMarker, MatcherBody, UrlPath } from "@plurnk/plurnk-grammar";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});

const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): EditStatement => ({
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
    // @graph derives at manifest-add (engine-side, §mimetype) — building the manifest
    // walks every entry and populates the symbol index from its content.
    await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId }));
    return { db, workspaceId, workerId };
};

const find = (db: import("../../src/core/Db.ts").Db, workspaceId: number, workerId: number, raw: string) =>
    new Worker().find(findStmt(url(""), graph(raw)), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));

test("[#640-graph-readiness] graph FIND reports an incomplete persistent index instead of silently dropping entries", async () => {
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

test("[#186-graph-referrers] @<foo finds entries that REFERENCE foo (not the definer)", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        const r = await find(db, workspaceId, workerId, "@<foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///b.ts"]);
        assert.deepEqual(r.results[0]?.matches, [
            {
                region: {
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 27,
                },
            },
            {
                region: {
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 7,
                },
            },
        ], "graph evidence uses honest enclosing source lines for the import and call");
    } finally { db.close(); }
});

test("[#186-graph-referents] @>foo finds entries DEFINING what foo references", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        const r = await find(db, workspaceId, workerId, "@>foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///c.ts"]);
    } finally { db.close(); }
});

test("[#186-graph-neighborhood] @foo = def ∪ referrers ∪ referents", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        const r = await find(db, workspaceId, workerId, "@foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///a.ts", "worker:///b.ts", "worker:///c.ts"]);
    } finally { db.close(); }
});

test("[#186-graph-miss] @<nope (no such symbol) → 200 with empty results", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        const r = await find(db, workspaceId, workerId, "@<nope");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], []);
    } finally { db.close(); }
});

test("[#186-graph-rederive] editing foo's referrer away drops it from @<foo", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        // b.ts no longer references foo — re-deriving its rows must remove the edge.
        await new Worker().edit(editStmt(url("b.ts"), "export const x = 1;\n", fullReplace), makeSchemeCtx({ db, workspaceId, workerId }));
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId }));  // re-derive at manifest-add
        const r = await find(db, workspaceId, workerId, "@<foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], []);
    } finally { db.close(); }
});

test("[#186-graph-gate] manifest-add re-derives only on content change (the deep_hash gate)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `gate-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(editStmt(url("a.ts"), "export function foo() {}\n"), ctx);

        // Fresh counting wrapper — never mutate the shared DEFAULT_MIMETYPES (intg
        // runs concurrently). Counts only the symbols+references parse.
        let parses = 0;
        const counting = {
            process: (...args: Parameters<typeof DEFAULT_MIMETYPES.process>) => {
                if (args[1]?.channels?.includes("symbols")) parses++;
                return DEFAULT_MIMETYPES.process(...args);
            },
        } as unknown as typeof DEFAULT_MIMETYPES;
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
