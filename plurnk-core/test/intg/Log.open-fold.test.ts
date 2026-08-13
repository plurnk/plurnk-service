// log:/// scheme participates in the model's curation surface via OPEN/FOLD
// on log:///N/T/S URIs. Underlying storage is the log_entries table (separate
// from entries+entry_channels); the expanded column toggles visibility.
// log entries lack channels and many other entry properties but share the
// URI-dispatched open/fold mechanism.

import test from "node:test";
import assert from "node:assert/strict";
import Log from "../../src/schemes/Log.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, openStmt, foldStmt, findStmt } from "./_dsl.ts";

const setup = async (attrs = "{}") => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    // Seed a log entry at coordinate (loop=1, turn=1, sequence=1).
    await db.engine_insert_log_entry.get({
        worker_id: workerId, loop_id: loopId, turn_id: turnId,
        sequence: 1,
        origin: "plurnk",
        source: null,
        op: "EDIT", suffix: "",
        signal: null,
        scheme: "worker", username: null, password: null,
        hostname: null, port: null,
        pathname: "/x", query: null, fragment: null,
        lineMarker: null,
        tx: "## EDIT0 (worker:///x)\nbody", mimetype_tx: "text/vnd.plurnk",
        rx: JSON.stringify({ status: 201 }), mimetype_rx: "application/json",
        status_rx: 201, tokens: 0,
        state: "resolved", outcome: null, attrs,
    });
    return { db, workspaceId, workerId, loopId, turnId };
};

const getExpanded = async (db: Awaited<ReturnType<typeof openMigrated>>, workerId: number): Promise<number> => {
    const row = await db.test_get_log_expanded.get<{ expanded: number }>({
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

test("FOLD accepts the canonical /OP suffix", async () => {
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

test("FOLD rejects a supplied /OP suffix that disagrees with the addressed row", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const r = await new Log().fold(
            foldStmt(urlPath("log", "/1/1/1/READ")),
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(r.status, 404);
        assert.equal(await getExpanded(db, workerId), 1, "a discordant address cannot curate the row");
    } finally { await db.close(); }
});

test("a tag filter does not turn a discordant exact /OP suffix into a successful no-op", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const result = await new Log().fold(
            { ...foldStmt(urlPath("log", "/1/1/1/READ")), signal: ["memory"] },
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }),
        );
        assert.equal(result.status, 404);
        assert.equal(await getExpanded(db, workerId), 1, "a discordant exact address cannot curate the row");
    } finally { await db.close(); }
});

test("a typed entry-materialization row resolves by its projected /READ suffix, not its durable EDIT event", async () => {
    const accepted = await setup('{"kind":"entry_materialized"}');
    try {
        const result = await new Log().fold(
            foldStmt(urlPath("log", "/1/1/1/READ")),
            makeSchemeCtx({ ...accepted, writer: "model" }),
        );
        assert.equal(result.status, 200);
    } finally { await accepted.db.close(); }

    const rejected = await setup('{"kind":"entry_materialized"}');
    try {
        const result = await new Log().fold(
            foldStmt(urlPath("log", "/1/1/1/EDIT")),
            makeSchemeCtx({ ...rejected, writer: "model" }),
        );
        assert.equal(result.status, 404);
    } finally { await rejected.db.close(); }
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

test("OPEN/FOLD are friendly visibility no-ops on valid bodyless entries", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const log = new Log();
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" });
        const target = urlPath("log", "/1/1/1");

        const alreadyOpen = await log.open(openStmt(target), ctx);
        assert.equal(alreadyOpen.status, 200);
        assert.equal(alreadyOpen.matched, 1);
        assert.equal(await getExpanded(db, workerId), 1);

        await log.fold(foldStmt(target), ctx);
        const alreadyFolded = await log.fold(foldStmt(target), ctx);
        assert.equal(alreadyFolded.status, 200);
        assert.equal(alreadyFolded.matched, 1);
        assert.equal(await getExpanded(db, workerId), 0);

        const foldedBodyless = await log.open(openStmt(target), ctx);
        assert.equal(foldedBodyless.status, 200);
        assert.equal(foldedBodyless.matched, 1);
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
        // A synthetic environment-delta row ({§env-delta}): origin=plurnk, source=a scheme.
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId,
            sequence: 2, origin: "plurnk", source: "file",
            op: "EDIT", suffix: "", signal: null,
            scheme: "file", username: null, password: null, hostname: null, port: null,
            pathname: "/config.toml", query: null, fragment: null, lineMarker: null,
            tx: "## EDIT0 (file:///config.toml)", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
            status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const rows = await db.engine_render_log.all<{ sequence: number; source: string | null }>({ worker_id: workerId });
        assert.equal(rows.find((r) => r.sequence === 2)?.source, "file", "the delta's cause round-trips the render query → packet-wire renders source=\"file\"");
        assert.equal(rows.find((r) => r.sequence === 1)?.source, null, "a self-authored entry has null source — rendered without a worker= label");
    } finally { await db.close(); }
});

test("FOLD and OPEN apply the same tag + matcher filter", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        // setup seeds bodyless 1/1/1 EDIT; add discriminating READ bodies at 1/1/2 and 1/1/3.
        const seedRead = async (sequence: number, content: string): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                origin: "model", source: null, op: "READ", suffix: "", signal: null,
                scheme: "worker", username: null, password: null, hostname: null, port: null,
                pathname: "/doc", query: null, fragment: null, lineMarker: null,
                tx: "## READ0 (worker:///doc)", mimetype_tx: "text/vnd.plurnk",
                rx: JSON.stringify({ status: 200, content, mimetype: "text/plain", startLine: 1 }), mimetype_rx: "application/json",
                status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
            });
            assert.ok(row !== undefined);
            return row.id;
        };
        const retainedId = await seedRead(2, "retain this row");
        await seedRead(3, "discard this row");
        await db.log_write_tag.run({ log_entry_id: retainedId, tag: "memory" });
        const expandedAt = async (sequence: number): Promise<number> =>
            (await db.test_get_log_expanded.get<{ expanded: number }>({
                worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence,
            }))?.expanded ?? -1;

        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" });
        const matcher = { dialect: "regex" as const, raw: "/retain/", pattern: "retain", flags: "" };
        const fold = await new Log().fold({
            ...foldStmt(urlPath("log", "/**/READ")),
            signal: ["memory"],
            body: matcher,
        }, ctx);
        assert.equal(fold.status, 200);
        assert.equal(fold.matched, 1);
        assert.equal(await expandedAt(2), 0, "the matching READ row is folded");
        assert.equal(await expandedAt(3), 1, "the non-matching READ row remains open");
        assert.equal(await expandedAt(1), 1, "the non-matching EDIT (1/1/1) is untouched");

        const tags = await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: workerId });
        assert.deepEqual(tags, [{ coordinate: "1/1/2", tag: "memory" }], "FOLD preserves the existing classification");

        const open = await new Log().open({
            ...openStmt(null),
            signal: ["memory"],
            body: matcher,
        }, ctx);
        assert.equal(open.status, 200);
        assert.equal(open.matched, 1);
        assert.equal(await expandedAt(2), 1, "targetless OPEN filters the worker log by tag + matcher");
        assert.equal(await expandedAt(3), 1, "OPEN does not broaden the tagged set");
    } finally { await db.close(); }
});

test("log curation honors segment-local `*` and recursive `**`", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const log = new Log();
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" });

        const shallow = await log.fold(foldStmt(urlPath("log", "/*")), ctx);
        assert.equal(shallow.status, 204, "no row lives directly at the log root");
        assert.equal(await getExpanded(db, workerId), 1, "`*` does not cross coordinate separators");

        const turnRows = await log.fold(foldStmt(urlPath("log", "/1/1/*")), ctx);
        assert.equal(turnRows.status, 200, "the documented loop/turn/item hierarchy reaches rows with one star");
        assert.equal(turnRows.matched, 1);
        assert.equal(await getExpanded(db, workerId), 0, "the rendered /OP decoration is not a mandatory hierarchy level");

        await log.open(openStmt(urlPath("log", "/1/1/*")), ctx);
        const recursive = await log.fold(foldStmt(urlPath("log", "/**")), ctx);
        assert.equal(recursive.status, 200);
        assert.equal(await getExpanded(db, workerId), 0, "`**` reaches recursive log rows");
    } finally { await db.close(); }
});

// {§model-entry-log-curation}
test("KILL permanently erases the addressed log row", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        assert.equal(await getExpanded(db, workerId), 1, "row exists before KILL");
        const r = await new Log().kill("/1/1/1", null, makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }));
        assert.equal(r.status, 200, "KILL on a log item succeeds");
        assert.equal(await getExpanded(db, workerId), -1, "the addressed row is gone");
    } finally { await db.close(); }
});

test("KILL erases an op='error' log item exactly like any other — errors ARE normal log items", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        // Seed an actionless op='error' row at 1/1/2 (the errors-into-log shape).
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 2,
            origin: "model", source: "grammar", op: "error", suffix: "", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ message: "parse error", snippet: "bad" }), mimetype_rx: "application/json",
            status_rx: 400, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const r = await new Log().kill("/1/1/2", null, makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }));
        assert.equal(r.status, 200, "an error row is KILLable exactly like any log item — no special-casing");
        const gone = await db.test_get_log_expanded.get({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(gone, undefined, "the error row is gone");
    } finally { await db.close(); }
});

test("FOLD(log:///1/1/) folds the turn's rows — the trailing slash means the contents, uniform with READ(folder/)", async () => {
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

test("a zero-match sweep is a NO-OP SUCCESS — 204 with matched: 0, never an error", async () => {
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

test("{§log-coordinate-hierarchy} a partial coordinate is a prefix with or without a trailing slash", async () => {
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

test("FOLD[tag] and OPEN[tag] symmetrically filter ALL-tag classifications", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup(); // seeds 1/1/1 EDIT
    try {
        const seedRead = async (sequence: number): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                origin: "model", source: null, op: "READ", suffix: "", signal: null,
                scheme: "worker", username: null, password: null, hostname: null, port: null,
                pathname: "/doc", query: null, fragment: null, lineMarker: null,
                tx: "## READ0 (worker:///doc)", mimetype_tx: "text/vnd.plurnk",
                rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
                status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
            });
            assert.ok(row !== undefined);
            return row.id;
        };
        const classifiedId = await seedRead(2);
        await seedRead(3);
        await db.log_write_tag.run({ log_entry_id: classifiedId, tag: "projectB" });
        await db.log_write_tag.run({ log_entry_id: classifiedId, tag: "hot" });
        const mk = () => makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" });
        const log = new Log();
        const expandedAt = async (seq: number): Promise<number> =>
            (await db.test_get_log_expanded.get<{ expanded: number }>({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: seq }))?.expanded ?? -1;

        const fold = await log.fold({ ...foldStmt(null), signal: ["projectB"] }, mk());
        assert.equal(fold.status, 200);
        assert.equal(fold.matched, 1);
        assert.equal(await expandedAt(2), 0, "row 2 folded");

        // FIND's signal classifies its own durable receipt at the Dispatcher seam; it does
        // not filter the rows returned by the scheme.
        const found = await log.find(findStmt(urlPath("log", "/"), null, ["+projectB"]), mk());
        assert.equal(found.status, 200);
        assert.equal(found.results.length, 3);
        const foundItem = found.results.find((item) => Array.isArray(item) && item[0].path.includes("/1/1/2/"));
        assert.ok(foundItem !== undefined && Array.isArray(foundItem) && "tags" in foundItem[0]);
        assert.deepEqual(foundItem[0].tags, ["hot", "projectB"], "the catalog exposes the row's complete classification");

        // RECALL: a TARGETLESS OPEN[projectB] reopens the whole named working-set.
        const open = await log.open({ ...openStmt(null), signal: ["projectB"] }, mk());
        assert.equal(open.status, 200);
        assert.equal(open.matched, 1);
        assert.equal(await expandedAt(2), 1, "row 2 recalled by name");

        // An unknown tag is a no-op success (204), never an error.
        assert.equal((await log.open({ ...openStmt(null), signal: ["ghost"] }, mk())).status, 204, "recalling an unused name steers nothing");
        const emptySurvey = await log.find(findStmt(urlPath("log", "/"), null, ["+ghost"]), mk());
        assert.equal(emptySurvey.status, 200);
        assert.equal(emptySurvey.results.length, 3, "FIND signals classify their own receipt; they do not filter log candidates");

        const both = await log.fold({ ...foldStmt(null), signal: ["projectB", "hot"] }, mk());
        assert.equal(both.status, 200);
        assert.equal(both.matched, 1, "ALL-tags AND selects the one row carrying both classifications");
        assert.equal((await log.open({ ...openStmt(null), signal: ["projectB", "cold"] }, mk())).status, 204, "a missing required tag selects no rows");
    } finally { await db.close(); }
});

test("FOLD/OPEN tag changes apply only after unsigned tags select the log set", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const row = await db.test_log_entries_by_worker.all<{ id: number }>({ worker_id: workerId });
        const id = row[0]?.id;
        assert.ok(id !== undefined);
        await db.log_write_tag.run({ log_entry_id: id, tag: "research" });
        await db.log_write_tag.run({ log_entry_id: id, tag: "stale" });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" });
        const log = new Log();

        const folded = await log.fold({ ...foldStmt(null), signal: ["research", "+archive", "-stale"] }, ctx);
        assert.equal(folded.status, 200);
        assert.equal(folded.matched, 1);
        assert.equal(await getExpanded(db, workerId), 0);
        assert.deepEqual(
            (await db.test_log_tags_by_worker.all<{ tag: string }>({ worker_id: workerId })).map(({ tag }) => tag),
            ["archive", "research"],
        );

        const opened = await log.open({ ...openStmt(null), signal: ["archive", "-archive"] }, ctx);
        assert.equal(opened.status, 200);
        assert.equal(await getExpanded(db, workerId), 1);
        assert.deepEqual(
            (await db.test_log_tags_by_worker.all<{ tag: string }>({ worker_id: workerId })).map(({ tag }) => tag),
            ["research"],
        );

        assert.equal((await log.fold({ ...foldStmt(null), signal: ["+orphan"] }, ctx)).status, 400);
        assert.equal((await log.fold({ ...foldStmt(null), signal: ["research", "+x", "-x"] }, ctx)).status, 400);
    } finally { await db.close(); }
});

test("FOLD/OPEN curate engine-minted error rows through the same operation coordinate grammar", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        // An engine-minted ERROR row (op='error', LOWERCASE) at seq=2. A
        // `[A-Z]+`-only coordinate suffix once made these rows incuratable.
        // Curation must work identically on every log row.
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 2,
            origin: "plurnk", source: "rail", op: "error", suffix: "", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 429, kind: "max_commands_exceeded", message: "too many commands" }),
            mimetype_rx: "application/json", status_rx: 429, tokens: 50, state: "failed", outcome: "max_commands_exceeded", attrs: "{}",
        });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" });
        // The model's exact gesture — fold the error row by its canonical operation address.
        const fold = await new Log().fold(foldStmt(urlPath("log", "/1/1/2/error")), ctx);
        assert.equal(fold.status, 200, "an error row folds by coordinate — the model can reclaim budget by curating its OWN error rows");
        const folded = await db.test_get_log_expanded.get<{ expanded: number }>({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(folded?.expanded, 0, "the error row is folded away");
        // OPEN it back — full parity with model-op rows.
        const open = await new Log().open(openStmt(urlPath("log", "/1/1/2/error")), ctx);
        assert.equal(open.status, 200, "OPEN(log:///1/1/2/error) restores it — the lowercase suffix parses for OPEN too");
    } finally { await db.close(); }
});
