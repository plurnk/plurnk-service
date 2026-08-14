// Tests for SEND[410] → scheme.delete pattern (SPEC {§send-dispatch}, {§send}).

import test from "node:test";
import assert from "node:assert/strict";
import type { SendStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, seedEnvelope, makeHandlerCtx, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, sendStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { workspaceId: number; workerId: number; loopId: number; turnId: number }, statement: SendStatement) =>
    engine.dispatch({ statement, ...env, sequence: 1, origin: "client" });

// De-anchored: SEND[410]-delete is an implemented side-effect, not a model-facing
// promise (delete idiom is MOVE to /dev/null, {§move}). Kept as engine regression coverage.
test("SEND[410](worker:///x) deletes the entry (side-effect; not model-facing)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/doomed"), "tomorrow"), makeSchemeCtx({ db, workspaceId, workerId }));
        const beforeDelete = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        assert.ok(beforeDelete !== undefined);

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(410, urlPath("worker", "/doomed")));
        assert.equal(r.status, 200);

        const afterDelete = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        assert.equal(afterDelete, undefined, "entry removed");
    } finally { await db.close(); }
});

test("SEND[410] on missing entry returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(410, urlPath("worker", "/nope")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("SEND[410] with #fragment deletes that channel only; entry remains", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/x"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(410, urlPath("worker", "/x", "body")));
        assert.equal(r.status, 200);

        const stillThere = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/x" });
        assert.ok(stillThere !== undefined, "entry row still present");
        const channel = await db.test_get_channel.get<{ name: string }>({ entry_id: stillThere?.id, name: "body" });
        assert.equal(channel, undefined, "body channel was removed");
    } finally { await db.close(); }
});

test("SEND[410] with #fragment on missing channel returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/y"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(410, urlPath("worker", "/y", "nonexistent")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("SEND[200] on entry scheme returns 501 (entry schemes don't interpret 200 directly)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/x"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(200, urlPath("worker", "/x")));
        assert.equal(r.status, 501);
    } finally { await db.close(); }
});

// SPEC.md {§send-status-policy} — directed-SEND status code policy. Entry schemes interpret
// 410 (Gone → delete) and 499 (Client Closed Request → cancel subscription).
// Every other status code returns 501 by default. New per-scheme overrides
// land when concrete use cases arise; the default stays 501.
for (const status of [201, 204, 304, 400, 404, 418, 422, 500, 503]) {
    test(`SEND[${status}](worker:///x) returns 501 (default policy)`, async () => {
        const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
        try {
            await new Worker().edit(editStmt(urlPath("worker", "/x"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
            const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(status, urlPath("worker", "/x")));
            assert.equal(r.status, 501, `SEND[${status}] should default to 501`);
        } finally { await db.close(); }
    });
}

test("SEND[410](worker:///x) deletes unknown entry", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/topic"), "open question"), makeSchemeCtx({ db, workspaceId, workerId }));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(410, urlPath("worker", "/topic")));
        assert.equal(r.status, 200);
        const gone = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/topic" });
        assert.equal(gone, undefined);
    } finally { await db.close(); }
});

test("SEND[410](skill:///x) deletes skill entry", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const Skill = (await import("../../src/schemes/Skill.ts")).default;
        await new Skill().edit(editStmt(urlPath("skill", "/grep"), "search text"), makeHandlerCtx(makeSchemeCtx({ db, workspaceId, workerId }), Skill.manifest));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(410, urlPath("skill", "/grep")));
        assert.equal(r.status, 200);
        const gone = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/grep" });
        assert.equal(gone, undefined);
    } finally { await db.close(); }
});

test("SEND[410] cascades to entry channels", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const k = new Worker();
        await k.edit(editStmt(urlPath("worker", "/doomed"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const entryRow = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        const entryId = entryRow!.id;
        assert.ok(((await db.test_count_channels_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n ?? 0) > 0);

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(410, urlPath("worker", "/doomed")));
        assert.equal(r.status, 200);

        assert.equal((await db.test_count_channels_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n, 0);
    } finally { await db.close(); }
});
