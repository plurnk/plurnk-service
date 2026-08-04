import test from "node:test";
import assert from "node:assert/strict";
import Skill from "../../src/schemes/Skill.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, makeHandlerCtx, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, openStmt, foldStmt, fullReplace } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

test("Skill.edit writes a commons-owned entry with scheme='skill'", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const r = await new Skill().edit(editStmt(urlPath("skill", "/shell/grep"), "find text in files using grep", ["shell", "search"]), makeHandlerCtx(makeSchemeCtx({ db, workspaceId, workerId }), Skill.manifest));
        assert.equal(r.status, 201);
        const entry = await db.test_get_entry_by_id.get<{ pathname: string }>({ id: r.entryId });
        assert.equal(entry?.pathname, "/shell/grep");
    } finally { await db.close(); }
});

test("Skill: scheme isolation from known and unknown", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const skill = new Skill();
        const commons = new Worker();
        await skill.edit(editStmt(urlPath("skill", "/x"), "skill body"), makeHandlerCtx(makeSchemeCtx({ db, workspaceId, workerId }), Skill.manifest));
        await commons.edit(editStmt(urlPath("worker", "/x"), "commons body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const rows = await db.test_list_entry_schemes.all<{ scheme: string }>();
        assert.deepEqual(rows.map((r) => r.scheme).toSorted(), ["skill", "worker"], "same pathname, two schemes — scheme is part of the identity");
    } finally { await db.close(); }
});

test("Skill.read: existing → 200 with content; missing → 404", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const s = new Skill();
        await s.edit(editStmt(urlPath("skill", "/grep"), "grep skill body"), makeHandlerCtx(makeSchemeCtx({ db, workspaceId, workerId }), Skill.manifest));
        const found = await s.read(readStmt(urlPath("skill", "/grep")), makeHandlerCtx(makeSchemeCtx({ db, workspaceId }), Skill.manifest));
        assert.equal(found.status, 200);
        assert.equal(found.content, "grep skill body");
        const missing = await s.read(readStmt(urlPath("skill", "/nope")), makeHandlerCtx(makeSchemeCtx({ db, workspaceId }), Skill.manifest));
        assert.equal(missing.status, 404);
    } finally { await db.close(); }
});

test("Skill.edit + read: idempotent on same path", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const s = new Skill();
        const first = await s.edit(editStmt(urlPath("skill", "/x"), "first"), makeHandlerCtx(makeSchemeCtx({ db, workspaceId, workerId }), Skill.manifest));
        const second = await s.edit(editStmt(urlPath("skill", "/x"), "second", null, fullReplace), makeHandlerCtx(makeSchemeCtx({ db, workspaceId, workerId }), Skill.manifest));
        assert.equal(first.status, 201);
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId);
        const read = await s.read(readStmt(urlPath("skill", "/x")), makeHandlerCtx(makeSchemeCtx({ db, workspaceId }), Skill.manifest));
        assert.equal(read.content, "second");
    } finally { await db.close(); }
});
