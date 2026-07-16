// grammar 0.46 regex-in-path: a `#pattern#flags` target selects entries whose
// PATHNAME matches the regex (not a glob). Seeds distinguishing pathnames so a
// glob or literal couldn't pass by accident — a path-anchored regex proves it.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, UrlPath, ParsedPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known:///${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});

const regexPath = (pattern: string, flags = ""): ParsedPath => ({
    kind: "regex", raw: flags ? `#${pattern}#${flags}` : `#${pattern}#`, pattern, flags,
});

const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const findStmt = (target: ParsedPath): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

const seed = async (
    db: import("../../src/core/Db.ts").Db,
    workspaceId: number,
    workerId: number,
    paths: string[],
) => {
    const k = new Known();
    for (const p of paths) {
        await k.edit(editStmt(url(p), `content of ${p}`), makeSchemeCtx({ db, workspaceId, workerId }));
    }
};

test("regex target selects entries whose pathname matches the regex", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seed(db, workspaceId, workerId, ["src/auth.ts", "src/auth.test.ts", "src/login.ts", "docs/auth.md"]);
        // `\.test\.ts$` — an end-anchored path regex. Only the test file matches; a literal
        // or a bare-prefix glob can't produce this, so a hit proves regex-over-pathname.
        const r = await new Known().find(findStmt(regexPath("\\.test\\.ts$")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["known:///src/auth.test.ts"]);
    } finally { db.close(); }
});

test("regex target honors flags — case-insensitive pathname match", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seed(db, workspaceId, workerId, ["README.md", "src/readme-helper.ts", "src/other.ts"]);
        const r = await new Known().find(findStmt(regexPath("readme", "i")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))].sort(), ["known:///README.md", "known:///src/readme-helper.ts"]);
    } finally { db.close(); }
});

test("malformed regex target is a 400, not a crash", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seed(db, workspaceId, workerId, ["a.ts"]);
        const r = await new Known().find(findStmt(regexPath("(unclosed")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 400);
    } finally { db.close(); }
});
