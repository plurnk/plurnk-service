// log:/// scheme participates in the model's curation surface via OPEN/FOLD
// on log:///N/T/S URIs. Underlying storage is the log_entries table (separate
// from entries+entry_channels); the indexed column toggles visibility.
// log entries lack channels and many other entry properties but share the
// URI-dispatched open/fold mechanism.

import test from "node:test";
import assert from "node:assert/strict";
import Log from "../../src/schemes/Log.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, openStmt, foldStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    // Seed a log entry at coordinate (loop=1, turn=1, sequence=1).
    await (db.engine_insert_log_entry as PrepMethod).get({
        run_id: runId, loop_id: loopId, turn_id: turnId,
        sequence: 1,
        origin: "plurnk",
        source: null,
        op: "EDIT", suffix: "",
        signal: null,
        scheme: "known", username: null, password: null,
        hostname: null, port: null,
        pathname: "/x", params: null, fragment: null,
        lineMarker: null,
        tx: "<<EDIT(known:///x):body:EDIT", mimetype_tx: "text/vnd.plurnk",
        rx: JSON.stringify({ status: 201 }), mimetype_rx: "application/json",
        status_rx: 201, tokens: 0,
        state: "resolved", outcome: null, attrs: "{}",
    });
    return { db, sessionId, runId, loopId, turnId };
};

const getIndexed = async (db: Awaited<ReturnType<typeof openMigrated>>, runId: number): Promise<number> => {
    const row = await (db.test_get_log_indexed as PrepMethod).get<{ indexed: number }>({
        run_id: runId, loop_seq: 1, turn_seq: 1, sequence: 1,
    });
    return row?.indexed ?? -1;
};

test("new log entry defaults to indexed=1", async () => {
    const { db, runId } = await setup();
    try {
        assert.equal(await getIndexed(db, runId), 1);
    } finally { await db.close(); }
});

test("FOLD(log:///1/1/1) flips indexed to 0", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/1/1/1")),
            makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 200);
        assert.equal(await getIndexed(db, runId), 0);
    } finally { await db.close(); }
});

test("FOLD accepts the /op wire suffix (self-documenting URI)", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/1/1/1/EDIT")),
            makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 200);
        assert.equal(await getIndexed(db, runId), 0);
    } finally { await db.close(); }
});

test("OPEN(log:///1/1/1) flips indexed back to 1", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const log = new Log();
        await log.fold(foldStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }));
        const r = await log.open(openStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }));
        assert.equal(r.status, 200);
        assert.equal(await getIndexed(db, runId), 1);
    } finally { await db.close(); }
});

test("FOLD on nonexistent coordinate returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/9/9/9")),
            makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("FOLD on malformed path returns 400", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/garbage")),
            makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 400);
    } finally { await db.close(); }
});

test("engine_render_log carries the delta source; self-authored entries stay null", async () => {
    const { db, sessionId: _sessionId, runId, loopId, turnId } = await setup();
    try {
        // A synthetic environment-delta row (§env-delta): origin=plurnk, source=a scheme.
        await (db.engine_insert_log_entry as PrepMethod).get({
            run_id: runId, loop_id: loopId, turn_id: turnId,
            sequence: 2, origin: "plurnk", source: "file",
            op: "EDIT", suffix: "", signal: null,
            scheme: "file", username: null, password: null, hostname: null, port: null,
            pathname: "/config.toml", params: null, fragment: null, lineMarker: null,
            tx: "<<EDIT(file:///config.toml)::EDIT", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
            status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const rows = await (db.engine_render_log as PrepMethod).all<{ sequence: number; source: string | null }>({ run_id: runId });
        assert.equal(rows.find((r) => r.sequence === 2)?.source, "file", "the delta's cause round-trips the render query → packet-wire renders run=\"file\"");
        assert.equal(rows.find((r) => r.sequence === 1)?.source, null, "a self-authored entry has null source — rendered without a run= label");
    } finally { await db.close(); }
});

test("FOLD(log:///**/READ)<1> folds the first matching READ row — glob + pagination", async () => {
    const { db, sessionId, runId, loopId, turnId } = await setup();
    try {
        // setup seeds 1/1/1 EDIT; add READ rows at 1/1/2 and 1/1/3.
        const seedRead = async (sequence: number): Promise<void> => {
            await (db.engine_insert_log_entry as PrepMethod).get({
                run_id: runId, loop_id: loopId, turn_id: turnId, sequence,
                origin: "model", source: null, op: "READ", suffix: "", signal: null,
                scheme: "known", username: null, password: null, hostname: null, port: null,
                pathname: "/doc", params: null, fragment: null, lineMarker: null,
                tx: "<<READ(known:///doc)::READ", mimetype_tx: "text/vnd.plurnk",
                rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
                status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
            });
        };
        await seedRead(2);
        await seedRead(3);
        const indexedAt = async (sequence: number): Promise<number> =>
            (await (db.test_get_log_indexed as PrepMethod).get<{ indexed: number }>({
                run_id: runId, loop_seq: 1, turn_seq: 1, sequence,
            }))?.indexed ?? -1;

        const stmt = { ...foldStmt(urlPath("log", "/**/READ")), lineMarker: { first: 1, last: 1 } };
        const r = await new Log().fold(stmt, makeSchemeCtx({ db, sessionId, runId, loopId, turnId, writer: "model" }));
        assert.equal(r.status, 200);
        assert.equal(await indexedAt(2), 0, "the 1st matched READ (1/1/2) is folded");
        assert.equal(await indexedAt(3), 1, "the 2nd READ (1/1/3) is untouched by <1>");
        assert.equal(await indexedAt(1), 1, "the non-matching EDIT (1/1/1) is untouched");
    } finally { await db.close(); }
});
