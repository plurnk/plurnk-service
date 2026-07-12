// @graph (plurnk-service#186) — FIND graph dialect over symbol_defs/symbol_refs.
//   @<sym  referrers — entries that REFERENCE sym
//   @>sym  referents — entries DEFINING what sym references
//   @sym   neighborhood — def ∪ referrers ∪ referents
// Symbol rows derive at the EDIT/write hook (EntryGraph.populate via mimetypes
// symbols+references channels); resolution is name-match across (session, scheme).

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known:///${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});

const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
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
    const sessionId = await insertSession(db, `graph-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const k = new Known();
    for (const [pathname, body] of FILES) {
        await k.edit(editStmt(url(pathname), body), makeSchemeCtx({ db, sessionId, runId }));
    }
    // @graph derives at manifest-add (engine-side, §mimetype) — building the manifest
    // walks every entry and populates the symbol index from its content.
    await EntryManifest.maintainDerivations(makeSchemeCtx({ db, sessionId, runId }));
    return { db, sessionId, runId };
};

const find = (db: import("../../src/core/Db.ts").Db, sessionId: number, runId: number, raw: string) =>
    new Known().find(findStmt(url(""), graph(raw)), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));

test("[#186-graph-referrers] @<foo finds entries that REFERENCE foo (not the definer)", async () => {
    const { db, sessionId, runId } = await seed();
    try {
        const r = await find(db, sessionId, runId, "@<foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["known:///b.ts"]);
    } finally { db.close(); }
});

test("[#186-graph-referents] @>foo finds entries DEFINING what foo references", async () => {
    const { db, sessionId, runId } = await seed();
    try {
        const r = await find(db, sessionId, runId, "@>foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["known:///c.ts"]);
    } finally { db.close(); }
});

test("[#186-graph-neighborhood] @foo = def ∪ referrers ∪ referents", async () => {
    const { db, sessionId, runId } = await seed();
    try {
        const r = await find(db, sessionId, runId, "@foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["known:///a.ts", "known:///b.ts", "known:///c.ts"]);
    } finally { db.close(); }
});

test("[#186-graph-miss] @<nope (no such symbol) → 200 with empty results", async () => {
    const { db, sessionId, runId } = await seed();
    try {
        const r = await find(db, sessionId, runId, "@<nope");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], []);
    } finally { db.close(); }
});

test("[#186-graph-rederive] editing foo's referrer away drops it from @<foo", async () => {
    const { db, sessionId, runId } = await seed();
    try {
        // b.ts no longer references foo — re-deriving its rows must remove the edge.
        await new Known().edit(editStmt(url("b.ts"), "export const x = 1;\n"), makeSchemeCtx({ db, sessionId, runId }));
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, sessionId, runId }));  // re-derive at manifest-add
        const r = await find(db, sessionId, runId, "@<foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], []);
    } finally { db.close(); }
});

test("[#186-graph-gate] manifest-add re-derives only on content change (the deep_hash gate)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `gate-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        await new Known().edit(editStmt(url("a.ts"), "export function foo() {}\n"), ctx);

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

        await EntryManifest.maintainDerivations(gctx);
        assert.equal(parses, 1, "first sight: content unseen → derive");
        await EntryManifest.maintainDerivations(gctx);
        assert.equal(parses, 1, "unchanged: deep_hash matches → skip the parse");

        await new Known().edit(editStmt(url("a.ts"), "export function bar() {}\n"), ctx);
        await EntryManifest.maintainDerivations(gctx);
        assert.equal(parses, 2, "content changed → re-derive");
    } finally { db.close(); }
});
