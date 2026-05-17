import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, ReadStatement, ShowStatement, HideStatement, ParsedPath, UrlPath } from "@plurnk/plurnk-grammar";
import Skill from "../../src/schemes/Skill.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (path: ParsedPath, body: string | null = null, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const readStmt = (path: ParsedPath): ReadStatement => ({
    op: "READ", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const showStmt = (path: ParsedPath | null): ShowStatement => ({
    op: "SHOW", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const hideStmt = (path: ParsedPath | null): HideStatement => ({
    op: "HIDE", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("Skill.edit: writes entry with scope='session' and scheme='skill'", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Skill().edit({
            db,
            statement: editStmt(urlPath("skill", "shell/grep"), "find text in files using grep", ["shell", "search"]),
            sessionId, runId,
        });
        assert.equal(r.status, 201);
        const entry = db.prepare("SELECT scheme, pathname FROM entries WHERE id = ?").get(r.entryId) as { scheme: string; pathname: string };
        assert.equal(entry.scheme, "skill");
        assert.equal(entry.pathname, "shell/grep");
    } finally { db.close(); }
});

test("Skill: scheme isolation from known and unknown", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const Known = (await import("../../src/schemes/Known.ts")).default;
        const Unknown = (await import("../../src/schemes/Unknown.ts")).default;
        const skill = new Skill();
        const known = new Known();
        const unknown = new Unknown();
        await skill.edit({ db, statement: editStmt(urlPath("skill", "/x"), "skill body"), sessionId, runId });
        await known.edit({ db, statement: editStmt(urlPath("known", "/x"), "known body"), sessionId, runId });
        await unknown.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "unknown body"), sessionId, runId });
        const rows = db.prepare("SELECT scheme FROM entries ORDER BY scheme").all() as { scheme: string }[];
        assert.deepEqual(rows.map((r) => r.scheme), ["known", "skill", "unknown"]);
    } finally { db.close(); }
});

test("Skill.read: existing → 200 with content; missing → 404", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const s = new Skill();
        await s.edit({ db, statement: editStmt(urlPath("skill", "grep"), "grep skill body"), sessionId, runId });
        const found = await s.read({ db, statement: readStmt(urlPath("skill", "grep")), sessionId });
        assert.equal(found.status, 200);
        assert.equal(found.content, "grep skill body");
        const missing = await s.read({ db, statement: readStmt(urlPath("skill", "nope")), sessionId });
        assert.equal(missing.status, 404);
    } finally { db.close(); }
});

test("Skill.show/hide: round-trip alternates state and 200/304 statuses", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const s = new Skill();
        const r = await s.edit({ db, statement: editStmt(urlPath("skill", "ping"), "ping skill"), sessionId, runId });
        const path = urlPath("skill", "ping");
        assert.equal((await s.show({ db, statement: showStmt(path), sessionId, runId })).status, 304);
        assert.equal((await s.hide({ db, statement: hideStmt(path), sessionId, runId })).status, 200);
        const visIndexed = (db.prepare("SELECT indexed FROM visibility WHERE run_id = ? AND entry_id = ?").get(runId, r.entryId) as { indexed: number }).indexed;
        assert.equal(visIndexed, 0);
        assert.equal((await s.hide({ db, statement: hideStmt(path), sessionId, runId })).status, 304);
        assert.equal((await s.show({ db, statement: showStmt(path), sessionId, runId })).status, 200);
    } finally { db.close(); }
});

test("Skill.edit + read: idempotent on same path", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const s = new Skill();
        const first = await s.edit({ db, statement: editStmt(urlPath("skill", "x"), "first"), sessionId, runId });
        const second = await s.edit({ db, statement: editStmt(urlPath("skill", "x"), "second"), sessionId, runId });
        assert.equal(first.status, 201);
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId);
        const read = await s.read({ db, statement: readStmt(urlPath("skill", "x")), sessionId });
        assert.equal(read.content, "second");
    } finally { db.close(); }
});
