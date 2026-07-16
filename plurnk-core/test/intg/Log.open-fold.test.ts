// log:/// scheme participates in the model's curation surface via OPEN/FOLD
// on log:///N/T/S URIs. Underlying storage is the log_entries table (separate
// from entries+entry_channels); the expanded column toggles visibility.
// log entries lack channels and many other entry properties but share the
// URI-dispatched open/fold mechanism.

import test from "node:test";
import assert from "node:assert/strict";
import Log from "../../src/schemes/Log.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, openStmt, foldStmt, findStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    // Seed a log entry at coordinate (loop=1, turn=1, sequence=1).
    await (db.engine_insert_log_entry as PrepMethod).get({
        worker_id: workerId, loop_id: loopId, turn_id: turnId,
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
    return { db, workspaceId, workerId, loopId, turnId };
};

const getExpanded = async (db: Awaited<ReturnType<typeof openMigrated>>, workerId: number): Promise<number> => {
    const row = await (db.test_get_log_expanded as PrepMethod).get<{ expanded: number }>({
        worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 1,
    });
    return row?.expanded ?? -1;
};

test("new log entry defaults to expanded=1", async () => {
    const { db, workerId } = await setup();
    try {
        assert.equal(await getExpanded(db, workerId), 1);
    } finally { await db.close(); }
});

test("FOLD(log:///1/1/1) flips expanded to 0", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/1/1/1")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 200);
        assert.equal(await getExpanded(db, workerId), 0);
    } finally { await db.close(); }
});

test("FOLD accepts the /op wire suffix (self-documenting URI)", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/1/1/1/EDIT")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 200);
        assert.equal(await getExpanded(db, workerId), 0);
    } finally { await db.close(); }
});

test("OPEN(log:///1/1/1) flips expanded back to 1", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const log = new Log();
        await log.fold(foldStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }));
        const r = await log.open(openStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }));
        assert.equal(r.status, 200);
        assert.equal(await getExpanded(db, workerId), 1);
    } finally { await db.close(); }
});

test("FOLD on nonexistent coordinate returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/9/9/9")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("FOLD on malformed path returns 400", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/garbage")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 400);
    } finally { await db.close(); }
});

test("engine_render_log carries the delta source; self-authored entries stay null", async () => {
    const { db, workspaceId: _workspaceId, workerId, loopId, turnId } = await setup();
    try {
        // A synthetic environment-delta row (§env-delta): origin=plurnk, source=a scheme.
        await (db.engine_insert_log_entry as PrepMethod).get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId,
            sequence: 2, origin: "plurnk", source: "file",
            op: "EDIT", suffix: "", signal: null,
            scheme: "file", username: null, password: null, hostname: null, port: null,
            pathname: "/config.toml", params: null, fragment: null, lineMarker: null,
            tx: "<<EDIT(file:///config.toml)::EDIT", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
            status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const rows = await (db.engine_render_log as PrepMethod).all<{ sequence: number; source: string | null }>({ worker_id: workerId });
        assert.equal(rows.find((r) => r.sequence === 2)?.source, "file", "the delta's cause round-trips the render query → packet-wire renders run=\"file\"");
        assert.equal(rows.find((r) => r.sequence === 1)?.source, null, "a self-authored entry has null source — rendered without a run= label");
    } finally { await db.close(); }
});

test("FOLD(log:///**/READ)<1> folds the first matching READ row — glob + pagination", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        // setup seeds 1/1/1 EDIT; add READ rows at 1/1/2 and 1/1/3.
        const seedRead = async (sequence: number): Promise<void> => {
            await (db.engine_insert_log_entry as PrepMethod).get({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
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
        const expandedAt = async (sequence: number): Promise<number> =>
            (await (db.test_get_log_expanded as PrepMethod).get<{ expanded: number }>({
                worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence,
            }))?.expanded ?? -1;

        const stmt: ReturnType<typeof foldStmt> = { ...foldStmt(urlPath("log", "/**/READ")), lineMarker: { marks: [1, 1] } };
        const r = await new Log().fold(stmt, makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }));
        assert.equal(r.status, 200);
        assert.equal(await expandedAt(2), 0, "the 1st matched READ (1/1/2) is folded");
        assert.equal(await expandedAt(3), 1, "the 2nd READ (1/1/3) is untouched by <1>");
        assert.equal(await expandedAt(1), 1, "the non-matching EDIT (1/1/1) is untouched");
    } finally { await db.close(); }
});

test("KILL(log:///1/1/1) erases the log row — the model's DB-storage curation lever (plurnk.md:36)", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        assert.equal(await getExpanded(db, workerId), 1, "row exists before KILL");
        const r = await new Log().kill("/1/1/1", null, makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }));
        assert.equal(r.status, 200, "KILL on a log item succeeds — not the old 405 append-only bounce");
        assert.equal(await getExpanded(db, workerId), -1, "the row is gone — storage freed (FOLD only collapses; KILL deletes)");
    } finally { await db.close(); }
});

test("KILL erases an op='error' log item exactly like any other — errors ARE normal log items", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        // Seed an actionless op='error' row at 1/1/2 (the errors-into-log shape).
        await (db.engine_insert_log_entry as PrepMethod).get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 2,
            origin: "model", source: "grammar", op: "error", suffix: "", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, params: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ message: "parse error", snippet: "bad" }), mimetype_rx: "application/json",
            status_rx: 400, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const r = await new Log().kill("/1/1/2", null, makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }));
        assert.equal(r.status, 200, "an error row is KILLable exactly like any log item — no special-casing");
        const gone = await (db.test_get_log_expanded as PrepMethod).get({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(gone, undefined, "the error row is gone");
    } finally { await db.close(); }
});

test("[§log-curation-folder-idiom] FOLD(log:///1/1/) folds the turn's rows — the trailing slash means the contents, uniform with READ(folder/)", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/1/1/")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 200);
        assert.equal(r.matched, 1, "the count of curated rows, clearly shown");
        assert.equal(await getExpanded(db, workerId), 0, "the turn's row folded");
    } finally { await db.close(); }
});

test("[§log-curation-folder-idiom] a zero-match sweep is a NO-OP SUCCESS — 204 with matched: 0, never an error (owner ruling)", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/9/9/")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 204, "204 stays OFF the errors surface — a sweep that found nothing steers nothing");
        assert.equal(r.matched, 0, "clearly shown");
        const star = await new Log().fold(
            foldStmt(urlPath("log", "/9/9/*")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(star.status, 204, "the explicit-glob form agrees");
    } finally { await db.close(); }
});

test("[§log-coordinate-hierarchy] a PARTIAL coordinate is a prefix, slash OPTIONAL — FOLD(log:///1/1) ≡ FOLD(log:///1/1/) folds the turn (#353-jumbo)", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        // The natural whole-turn fold the jumbo model reached for (no trailing slash) now resolves.
        const noSlash = await new Log().fold(
            foldStmt(urlPath("log", "/1/1")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(noSlash.status, 200, "log:///1/1 (no slash) folds turn 1/1 — no more 400");
        assert.equal(noSlash.matched, 1, "the turn's row");
        assert.equal(await getExpanded(db, workerId), 0);
        // And the loop prefix: log:///1 selects all of loop 1's rows.
        await new Log().open(openStmt(urlPath("log", "/1/1")), makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }));
        const loop = await new Log().fold(
            foldStmt(urlPath("log", "/1")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(loop.status, 200, "log:///1 folds loop 1's rows");
        assert.ok((loop.matched ?? 0) >= 1, "the loop prefix matched");
    } finally { await db.close(); }
});

test("[§log-region-tagging] FOLD[tag] applies + folds; OPEN[tag]/FIND[tag] filter by ALL-tags — named working-set curation", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup(); // seeds 1/1/1 EDIT
    try {
        const seedRead = async (sequence: number): Promise<void> => {
            await (db.engine_insert_log_entry as PrepMethod).get({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
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
        const mk = () => makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" });
        const log = new Log();
        const expandedAt = async (seq: number): Promise<number> =>
            (await (db.test_get_log_expanded as PrepMethod).get<{ expanded: number }>({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: seq }))?.expanded ?? -1;

        // WRITE: FOLD[projectB](log:///1/1/2) folds row 2 AND stamps the tag (FOLD is the log's write-op).
        const fold = await log.fold({ ...foldStmt(urlPath("log", "/1/1/2")), signal: ["projectB"] }, mk());
        assert.equal(fold.status, 200);
        assert.equal(fold.matched, 1);
        assert.equal(await expandedAt(2), 0, "row 2 folded");

        // READ/filter: FIND[projectB] over the whole run returns ONLY the tagged row (folded or not).
        const found = await log.find(findStmt(urlPath("log", "/"), null, ["projectB"]), mk());
        assert.equal(found.status, 200);
        assert.equal(found.results.length, 1, "only the tagged row matches");
        assert.match(found.results[0].path, /1\/1\/2/, "and it is row 2");

        // RECALL: a TARGETLESS OPEN[projectB] reopens the whole named working-set.
        const open = await log.open({ ...openStmt(null), signal: ["projectB"] }, mk());
        assert.equal(open.status, 200);
        assert.equal(open.matched, 1);
        assert.equal(await expandedAt(2), 1, "row 2 recalled by name");

        // An unknown tag is a no-op success (204), never an error.
        assert.equal((await log.open({ ...openStmt(null), signal: ["ghost"] }, mk())).status, 204, "recalling an unused name steers nothing");
        assert.equal((await log.find(findStmt(urlPath("log", "/"), null, ["ghost"]), mk())).status, 204);

        // Additive apply + ALL-tags AND: stamp a second tag on row 2, then FIND[both] matches, FIND[one-missing] doesn't.
        await log.fold({ ...foldStmt(urlPath("log", "/1/1/2")), signal: ["hot"] }, mk());
        assert.equal((await log.find(findStmt(urlPath("log", "/"), null, ["projectB", "hot"]), mk())).results.length, 1, "row 2 carries BOTH tags (additive) — ALL-tags AND matches");
        assert.equal((await log.find(findStmt(urlPath("log", "/"), null, ["projectB", "cold"]), mk())).status, 204, "missing one ANDed tag → no match");
    } finally { await db.close(); }
});

test("[§log-coordinate-hierarchy] FOLD/OPEN curate ENGINE-MINTED rows — the lowercase op suffix (error/model) parses, not just model ops (jumbo root cause)", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        // An engine-minted ERROR row (op='error', LOWERCASE) at seq=2 — the kind that bloats the log
        // under budget pressure and MUST be curatable. A `[A-Z]+`-only coordinate suffix silently 400'd
        // FOLD(log:///1/1/2/error), so the model could not reclaim budget by folding its own error rows
        // and spiralled to a hard-413 (the jumbo failure). Curation must work IDENTICALLY on every log
        // row, engine-minted or model-authored — the universal-op contract admits no exception.
        await (db.engine_insert_log_entry as PrepMethod).get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 2,
            origin: "model", source: null, op: "error", suffix: "", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, params: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 413, kind: "budget_overflow", message: "over budget" }),
            mimetype_rx: "application/json", status_rx: 413, tokens: 50, state: "failed", outcome: "budget_overflow", attrs: "{}",
        });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" });
        // The model's EXACT gesture — fold the error row by its self-documenting coordinate.
        const fold = await new Log().fold(foldStmt(urlPath("log", "/1/1/2/error")), ctx);
        assert.equal(fold.status, 200, "an error row folds by coordinate — the model can reclaim budget by curating its OWN error rows");
        const folded = await (db.test_get_log_expanded as PrepMethod).get<{ expanded: number }>({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(folded?.expanded, 0, "the error row is folded away");
        // OPEN it back — full parity with model-op rows.
        const open = await new Log().open(openStmt(urlPath("log", "/1/1/2/error")), ctx);
        assert.equal(open.status, 200, "OPEN(log:///1/1/2/error) restores it — the lowercase suffix parses for OPEN too");
    } finally { await db.close(); }
});
