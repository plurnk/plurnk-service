// log:// scheme participates in the model's curation surface via SHOW/HIDE
// on log://N/T/S URIs. Underlying storage is the log_entries table (separate
// from entries+entry_channels); the indexed column toggles visibility.
// log entries lack channels and many other entry properties but share the
// URI-dispatched show/hide mechanism.

import test from "node:test";
import assert from "node:assert/strict";
import Log from "../../src/schemes/Log.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, showStmt, hideStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    // Seed a log entry at coordinate (loop=1, turn=1, action_index=1).
    await (db.engine_insert_log_entry as PrepMethod).get({
        run_id: runId, loop_id: loopId, turn_id: turnId,
        action_index: 1,
        origin: "system",
        op: "EDIT", suffix: "",
        signal: null,
        scheme: "known", username: null, password: null,
        hostname: null, port: null,
        pathname: "x", params: null, fragment: null,
        lineMarker: null,
        tx: "<<EDIT(known://x):body:EDIT", mimetype_tx: "text/vnd.plurnk",
        rx: JSON.stringify({ status: 201 }), mimetype_rx: "application/json",
        status_rx: 201,
        state: "resolved", outcome: null, attrs: "{}",
    });
    return { db, sessionId, runId, loopId, turnId };
};

const getIndexed = async (db: Awaited<ReturnType<typeof openMigrated>>, runId: number): Promise<number> => {
    const row = await (db.test_get_log_indexed as PrepMethod).get<{ indexed: number }>({
        run_id: runId, loop_seq: 1, turn_seq: 1, action_index: 1,
    });
    return row?.indexed ?? -1;
};

test("new log entry defaults to indexed=1", async () => {
    const { db, runId } = await setup();
    try {
        assert.equal(await getIndexed(db, runId), 1);
    } finally { await db.close(); }
});

test("HIDE(log://1/1/1) flips indexed to 0", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const r = await new Log().hide(
            hideStmt(urlPath("log", "1/1/1")),
            makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 200);
        assert.equal(await getIndexed(db, runId), 0);
    } finally { await db.close(); }
});

test("HIDE accepts the /op wire suffix (self-documenting URI)", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const r = await new Log().hide(
            hideStmt(urlPath("log", "1/1/1/EDIT")),
            makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 200);
        assert.equal(await getIndexed(db, runId), 0);
    } finally { await db.close(); }
});

test("SHOW(log://1/1/1) flips indexed back to 1", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const log = new Log();
        await log.hide(hideStmt(urlPath("log", "1/1/1")), makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }));
        const r = await log.show(showStmt(urlPath("log", "1/1/1")), makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }));
        assert.equal(r.status, 200);
        assert.equal(await getIndexed(db, runId), 1);
    } finally { await db.close(); }
});

test("HIDE on nonexistent coordinate returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const r = await new Log().hide(
            hideStmt(urlPath("log", "9/9/9")),
            makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("HIDE on malformed path returns 400", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const r = await new Log().hide(
            hideStmt(urlPath("log", "garbage")),
            makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 400);
    } finally { await db.close(); }
});
