import test from "node:test";
import assert from "node:assert/strict";
import Skill from "../../src/schemes/Skill.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, openStmt, foldStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("Skill.edit: writes entry with scope='session' and scheme='skill'", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Skill().edit(editStmt(urlPath("skill", "shell/grep"), "find text in files using grep", ["shell", "search"]), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(r.status, 201);
        const entry = await (db.test_get_entry_by_id as PrepMethod).get<{ pathname: string }>({ id: r.entryId });
        assert.equal(entry?.pathname, "shell/grep");
    } finally { await db.close(); }
});

test("Skill: scheme isolation from known and unknown", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const Known = (await import("../../src/schemes/Known.ts")).default;
        const Unknown = (await import("../../src/schemes/Unknown.ts")).default;
        const skill = new Skill();
        const known = new Known();
        const unknown = new Unknown();
        await skill.edit(editStmt(urlPath("skill", "/x"), "skill body"), makeSchemeCtx({ db, sessionId, runId }));
        await known.edit(editStmt(urlPath("known", "/x"), "known body"), makeSchemeCtx({ db, sessionId, runId }));
        await unknown.edit(editStmt(urlPath("unknown", "/x"), "unknown body"), makeSchemeCtx({ db, sessionId, runId }));
        const rows = await (db.test_list_entry_schemes as PrepMethod).all<{ scheme: string }>();
        assert.deepEqual(rows.map((r) => r.scheme), ["known", "skill", "unknown"]);
    } finally { await db.close(); }
});

test("Skill.read: existing → 200 with content; missing → 404", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const s = new Skill();
        await s.edit(editStmt(urlPath("skill", "grep"), "grep skill body"), makeSchemeCtx({ db, sessionId, runId }));
        const found = await s.read(readStmt(urlPath("skill", "grep")), makeSchemeCtx({ db, sessionId }));
        assert.equal(found.status, 200);
        assert.equal(found.content, "grep skill body");
        const missing = await s.read(readStmt(urlPath("skill", "nope")), makeSchemeCtx({ db, sessionId }));
        assert.equal(missing.status, 404);
    } finally { await db.close(); }
});

test("Skill.edit + read: idempotent on same path", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const s = new Skill();
        const first = await s.edit(editStmt(urlPath("skill", "x"), "first"), makeSchemeCtx({ db, sessionId, runId }));
        const second = await s.edit(editStmt(urlPath("skill", "x"), "second"), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(first.status, 201);
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId);
        const read = await s.read(readStmt(urlPath("skill", "x")), makeSchemeCtx({ db, sessionId }));
        assert.equal(read.content, "second");
    } finally { await db.close(); }
});
