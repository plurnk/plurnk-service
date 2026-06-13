// Tests for SEND[410] → scheme.delete pattern (SPEC §3.5, §6.7).

import test from "node:test";
import assert from "node:assert/strict";
import type { SendStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, sendStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { sessionId: number; runId: number; loopId: number; turnId: number }, statement: SendStatement) =>
    engine.dispatch({ statement, ...env, sequence: 1, origin: "client" });

// De-anchored: SEND[410]-delete is an implemented side-effect, not a model-facing
// promise (delete idiom is MOVE to /dev/null, §6.5). Kept as engine regression coverage.
test("SEND[410](known://x) deletes the entry (side-effect; not model-facing)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "doomed"), "tomorrow"), makeSchemeCtx({ db, sessionId, runId }));
        const beforeDelete = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "doomed" });
        assert.ok(beforeDelete !== undefined);

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, urlPath("known", "doomed")));
        assert.equal(r.status, 200);

        const afterDelete = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "doomed" });
        assert.equal(afterDelete, undefined, "entry removed");
    } finally { await db.close(); }
});

test("SEND[410] on missing entry returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, urlPath("known", "nope")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("SEND[410] with #fragment deletes that channel only; entry remains", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "x"), "body"), makeSchemeCtx({ db, sessionId, runId }));
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, urlPath("known", "x", "body")));
        assert.equal(r.status, 200);

        const stillThere = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "x" });
        assert.ok(stillThere !== undefined, "entry row still present");
        const channel = await (db.test_get_channel as PrepMethod).get<{ name: string }>({ entry_id: stillThere?.id, name: "body" });
        assert.equal(channel, undefined, "body channel was removed");
    } finally { await db.close(); }
});

test("SEND[410] with #fragment on missing channel returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "y"), "body"), makeSchemeCtx({ db, sessionId, runId }));
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, urlPath("known", "y", "nonexistent")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("[§3.5-entry-schemes-501-on-non-410] SEND[200] on entry scheme returns 501 (entry schemes don't interpret 200 directly)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "x"), "body"), makeSchemeCtx({ db, sessionId, runId }));
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(200, urlPath("known", "x")));
        assert.equal(r.status, 501);
    } finally { await db.close(); }
});

// SPEC.md §16.9 — directed-SEND status code policy. Entry schemes interpret
// 410 (Gone → delete) and 499 (Client Closed Request → cancel subscription).
// Every other status code returns 501 by default. New per-scheme overrides
// land when concrete use cases arise; the default stays 501.
for (const status of [201, 204, 304, 400, 404, 418, 422, 500, 503]) {
    test(`[§3.5-entry-schemes-501-on-non-410] SEND[${status}](known://x) returns 501 (default policy)`, async () => {
        const { db, sessionId, runId, loopId, turnId, engine } = await setup();
        try {
            await new Known().edit(editStmt(urlPath("known", "x"), "body"), makeSchemeCtx({ db, sessionId, runId }));
            const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(status, urlPath("known", "x")));
            assert.equal(r.status, 501, `SEND[${status}] should default to 501`);
        } finally { await db.close(); }
    });
}

test("SEND[410](unknown://x) deletes unknown entry", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const Unknown = (await import("../../src/schemes/Unknown.ts")).default;
        await new Unknown().edit(editStmt(urlPath("unknown", "topic"), "open question"), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, urlPath("unknown", "topic")));
        assert.equal(r.status, 200);
        const gone = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "topic" });
        assert.equal(gone, undefined);
    } finally { await db.close(); }
});

test("SEND[410](skill://x) deletes skill entry", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const Skill = (await import("../../src/schemes/Skill.ts")).default;
        await new Skill().edit(editStmt(urlPath("skill", "grep"), "search text"), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, urlPath("skill", "grep")));
        assert.equal(r.status, 200);
        const gone = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "grep" });
        assert.equal(gone, undefined);
    } finally { await db.close(); }
});

test("SEND[410] cascades — channels and tags all removed", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const k = new Known();
        await k.edit({ ...editStmt(urlPath("known", "doomed"), "body"), signal: ["a", "b"] }, makeSchemeCtx({ db, sessionId, runId }));
        const entryRow = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "doomed" });
        const entryId = entryRow!.id;
        assert.ok(((await (db.test_count_channels_for_entry as PrepMethod).get<{ n: number }>({ entry_id: entryId }))?.n ?? 0) > 0);
        assert.ok(((await (db.test_count_entry_tags as PrepMethod).get<{ n: number }>({ entry_id: entryId }))?.n ?? 0) > 0);

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, urlPath("known", "doomed")));
        assert.equal(r.status, 200);

        assert.equal((await (db.test_count_channels_for_entry as PrepMethod).get<{ n: number }>({ entry_id: entryId }))?.n, 0);
        assert.equal((await (db.test_count_entry_tags as PrepMethod).get<{ n: number }>({ entry_id: entryId }))?.n, 0);
    } finally { await db.close(); }
});
