// {§graph-relations} over file:/// — the primary codebase-navigation case. Proves the
// symbol dialect resolves uniformly on file entries (scheme=file, bare-rendered):
// materialize files the way git-membership does → derive at manifest-add → FIND
// the graph dialect through File (using the shared entry backing).

import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-contracts";
import File from "../../src/schemes/File.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";
import { resourcePaths } from "./_find.ts";

const fileUrl = (pathname: string): UrlPath => ({
    kind: "url", raw: `file:///${pathname}`, scheme: "file",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const findStmt = (target: UrlPath, body: MatcherBody): FindStatement => ({
    op: "FIND", annotation: null, delimiter: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const graph = (raw: string): MatcherBody => ({ dialect: "graph", raw });

// src/a.ts defines foo (calls bar); src/b.ts references foo; src/c.ts defines bar.
const FILES: ReadonlyArray<readonly [string, string]> = [
    ["src/a.ts", "export function foo() {\n  bar();\n}\n"],
    ["src/b.ts", "import { foo } from \"./a\";\nfoo();\n"],
    ["src/c.ts", "export function bar() {}\n"],
];

const seed = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `gfile-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, workerId });
    // Materialize file entries exactly as git-membership does: writeEntry(scheme="file").
    for (const [pathname, content] of FILES) {
        await EntryCrud.writeEntry({ authority: "", pathname: `${pathname}` }, { channels: { body: { content, mimetype: "text/typescript" } } }, ctx, "file");
    }
    // Populate the graph through the pre-model persistent-index pass.
    await SearchIndex.maintain(ctx);
    return { db, workspaceId, workerId };
};

test("@graph resolves over file:/// entries", async () => {
    const { db, workspaceId, workerId } = await seed();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 });
        // FIND returns channel groups; a stored file resource renders its default path BARE
        // (slash-free, namespace-relative) — the same form the manifest catalogs and the
        // model types back, not the addressed file:/// form.
        const referrers = await new File().find(findStmt(fileUrl(""), graph("@<foo")), ctx);
        assert.equal(referrers.status, 200);
        assert.deepEqual([...new Set(resourcePaths(referrers))], ["src/b.ts"]);

        const referents = await new File().find(findStmt(fileUrl(""), graph("@>foo")), ctx);
        assert.deepEqual([...new Set(resourcePaths(referents))], ["src/c.ts"]);

        const neighborhood = await new File().find(findStmt(fileUrl(""), graph("@foo")), ctx);
        assert.deepEqual([...new Set(resourcePaths(neighborhood))], ["src/a.ts", "src/b.ts", "src/c.ts"]);
    } finally { db.close(); }
});
