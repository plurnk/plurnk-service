// Persona cascade (issue #150, migration 016). packet.system.persona is
// resolved at packet-build time by taking the first non-null value of:
//   loops.persona > runs.persona > sessions.persona > caller-supplied default
// These tests exercise the engine_resolve_persona SQL directly to confirm
// the COALESCE chain and the engine's fallback behavior.

import test from "node:test";
import assert from "node:assert/strict";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "./_helpers.ts";

const setLoopPersona = async (db: Db, id: number, persona: string | null): Promise<void> => {
    await (db.test_set_loop_persona as PrepMethod).run({ id, persona });
};
const setRunPersona = async (db: Db, id: number, persona: string | null): Promise<void> => {
    await (db.test_set_run_persona as PrepMethod).run({ id, persona });
};
const setSessionPersona = async (db: Db, id: number, persona: string | null): Promise<void> => {
    await (db.test_set_session_persona as PrepMethod).run({ id, persona });
};

const resolvePersona = async (db: Db, loopId: number): Promise<string | null> => {
    const row = await (db.engine_resolve_persona as PrepMethod).get<{ persona: string | null }>({ loop_id: loopId });
    return row?.persona ?? null;
};

test("[§15.3-null-falls-through] persona cascade: no overrides → null (caller's default kicks in)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "persona-cascade-1");
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "test");
        const resolved = await resolvePersona(db, loopId);
        assert.equal(resolved, null);
    } finally { await db.close(); }
});

test("persona cascade: only sessions.persona → that wins", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "persona-cascade-2");
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "test");
        await setSessionPersona(db, sessionId, "session-level");
        const resolved = await resolvePersona(db, loopId);
        assert.equal(resolved, "session-level");
    } finally { await db.close(); }
});

test("persona cascade: runs.persona overrides sessions.persona", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "persona-cascade-3");
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "test");
        await setSessionPersona(db, sessionId, "session-level");
        await setRunPersona(db, runId, "run-level");
        const resolved = await resolvePersona(db, loopId);
        assert.equal(resolved, "run-level");
    } finally { await db.close(); }
});

test("[§15.3-cascade-precedence] persona cascade: loops.persona is most specific — wins over everything", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "persona-cascade-4");
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "test");
        await setSessionPersona(db, sessionId, "session-level");
        await setRunPersona(db, runId, "run-level");
        await setLoopPersona(db, loopId, "loop-level");
        const resolved = await resolvePersona(db, loopId);
        assert.equal(resolved, "loop-level");
    } finally { await db.close(); }
});

test("persona cascade: middle layer null, outer set, inner set — inner wins", async () => {
    // COALESCE picks the first non-null. With sessions and loops both set
    // but runs null, loops.persona still wins (it's the leftmost arg).
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "persona-cascade-5");
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "test");
        await setSessionPersona(db, sessionId, "session-level");
        await setLoopPersona(db, loopId, "loop-level");
        const resolved = await resolvePersona(db, loopId);
        assert.equal(resolved, "loop-level");
    } finally { await db.close(); }
});

test("persona cascade: outer layer null, inner null, middle set — middle wins", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "persona-cascade-6");
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "test");
        await setRunPersona(db, runId, "run-level");
        const resolved = await resolvePersona(db, loopId);
        assert.equal(resolved, "run-level");
    } finally { await db.close(); }
});

test("[§15.3-empty-suppresses] persona cascade: empty string is treated as a non-null override", async () => {
    // SQL COALESCE returns the first non-NULL value; empty string is not
    // NULL. If a client explicitly sets persona="" (e.g. session.set_persona
    // with empty body) they're suppressing the cascade. Engine then renders
    // no persona section (renderSystemContent skips empty persona).
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "persona-cascade-7");
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "test");
        await setSessionPersona(db, sessionId, "session-level");
        await setLoopPersona(db, loopId, "");
        const resolved = await resolvePersona(db, loopId);
        assert.equal(resolved, "");
    } finally { await db.close(); }
});
