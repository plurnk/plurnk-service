// {§kill-scope-entry} — KILL on an entry deletes it (or one #channel); the untaught KILL
// delete idiom is gone with the signal slot. Engine regression coverage.

import test from "node:test";
import assert from "node:assert/strict";
import type { KillStatement, SendStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, seedEnvelope, makeHandlerCtx, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, killStmt, sendStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { workspaceId: number; workerId: number; loopId: number; turnId: number }, statement: SendStatement | KillStatement) =>
    engine.dispatch({ statement, ...env, sequence: 1, origin: "client" });

test("KILL(worker:///x) deletes the entry (side-effect; not model-facing)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/doomed"), "tomorrow"), makeSchemeCtx({ db, workspaceId, workerId }));
        const beforeDelete = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        assert.ok(beforeDelete !== undefined);

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/doomed")));
        assert.equal(r.status, 200);

        const afterDelete = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        assert.equal(afterDelete, undefined, "entry removed");
    } finally { await db.close(); }
});

test("KILL on missing entry returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/nope")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("KILL with #fragment deletes that channel only; entry remains", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/x"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/x", "body")));
        assert.equal(r.status, 200);

        const stillThere = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/x" });
        assert.ok(stillThere !== undefined, "entry row still present");
        const channel = await db.test_get_channel.get<{ name: string }>({ entry_id: stillThere?.id, name: "body" });
        assert.equal(channel, undefined, "body channel was removed");
    } finally { await db.close(); }
});

test("KILL with #fragment on missing channel returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/y"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/y", "nonexistent")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

// {§kill-scope-entry}
test("a scoped KILL deletes one span of an entry through the EDIT path; the log row records the KILL", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/notes.md"), "alpha\nbeta\ngamma"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/notes.md"), { marks: [2] }));
        assert.equal(r.status, 200, `the span deletion lands: ${JSON.stringify(r)}`);
        const body = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" });
        assert.equal(body?.content, "alpha\ngamma", "exactly the scoped line is gone");
        const row = await db.test_first_log_entry_for_turn.get<{ op: string; lineMarker: string | null }>({ turn_id: turnId });
        assert.equal(row?.op, "KILL", "the receipt is the model's own operation");
    } finally { await db.close(); }
});

test("a recipient SEND to an entry scheme returns 501 (entry schemes carry no messages)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/x"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(null, urlPath("worker", "/x"), "hello"));
        assert.equal(r.status, 501);
    } finally { await db.close(); }
});

test("KILL(worker:///x) deletes unknown entry", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/topic"), "open question"), makeSchemeCtx({ db, workspaceId, workerId }));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/topic")));
        assert.equal(r.status, 200);
        const gone = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/topic" });
        assert.equal(gone, undefined);
    } finally { await db.close(); }
});

test("KILL(skill:///x) deletes skill entry", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const Skill = (await import("../../src/schemes/Skill.ts")).default;
        await new Skill().edit(editStmt(urlPath("skill", "/grep"), "search text"), makeHandlerCtx(makeSchemeCtx({ db, workspaceId, workerId }), Skill.manifest));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("skill", "/grep")));
        assert.equal(r.status, 200);
        const gone = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/grep" });
        assert.equal(gone, undefined);
    } finally { await db.close(); }
});

test("KILL cascades to entry channels", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const k = new Worker();
        await k.edit(editStmt(urlPath("worker", "/doomed"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const entryRow = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        const entryId = entryRow!.id;
        assert.ok(((await db.test_count_channels_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n ?? 0) > 0);

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/doomed")));
        assert.equal(r.status, 200);

        assert.equal((await db.test_count_channels_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n, 0);
    } finally { await db.close(); }
});
