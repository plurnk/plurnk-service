// {§log-kill-scope} — the log:/// scheme's curation surface is KILL on log:///N/T/S URIs.
// A whole-item KILL retires the row from the active projection; a scoped KILL folds one
// body interval away for good (one-way: there is no OPEN). Durable history is stored
// separately from the active/folded projection, and both are independent of
// entries+entry_channels. Log entries lack channels and many other entry properties
// but share the URI-dispatched curation mechanism.

import test from "node:test";
import assert from "node:assert/strict";
import type { TextLineMarker } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Log from "../../src/schemes/Log.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { urlPath, killStmt, findStmt, regex } from "./_dsl.ts";

const WHOLE: TextLineMarker = { marks: [1, -1] };

const setup = async (attrs = "{}", span = "body") => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    // Seed a log entry at coordinate (loop=1, turn=1, sequence=1).
    await db.engine_insert_log_entry.get({
        worker_id: workerId, loop_id: loopId, turn_id: turnId,
        sequence: 1,
        origin: "_plurnk",
        source: null,
        model_call_id: null,
        op: "EDIT", delimiter: "",
        scheme: "worker", username: null, password: null,
        hostname: null, port: null,
        pathname: "/x", query: null, fragment: null,
        lineMarker: null,
        tx: "### EDIT0 (worker:///x)\nbody", mimetype_tx: "text/vnd.plurnk",
        rx: JSON.stringify({ status: 201, ...(span.length === 0 ? {} : { span }) }), mimetype_rx: "application/json",
        status_rx: 201, weight: 0,
        state: "resolved", outcome: null, attrs,
    });
    return { db, workspaceId, workerId, loopId, turnId };
};

const ctxOf = ({ db, workspaceId, workerId, loopId, turnId }: Awaited<ReturnType<typeof setup>>) =>
    makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" });

const getFolded = async (db: Awaited<ReturnType<typeof openMigrated>>, workerId: number, sequence = 1): Promise<string | undefined> => {
    const row = await db.test_get_log_folded.get<{ folded: string }>({
        worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence,
    });
    return row?.folded;
};

const seedRead = async ({ db, workerId, loopId, turnId }: Awaited<ReturnType<typeof setup>>, sequence: number, content: string): Promise<number> => {
    const row = await db.engine_insert_log_entry.get<{ id: number }>({
        worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
        origin: "model", source: null, model_call_id: null, op: "READ", delimiter: "",
        scheme: "worker", username: null, password: null, hostname: null, port: null,
        pathname: `/doc-${sequence}`, query: null, fragment: null, lineMarker: null,
        tx: "", mimetype_tx: "text/plain",
        rx: JSON.stringify({ status: 200, content, mimetype: "text/plain", startLine: 1 }),
        mimetype_rx: "application/json", status_rx: 200, weight: content.length,
        state: "resolved", outcome: null, attrs: "{}",
    });
    if (row === undefined) throw new Error("READ fixture insert returned no row");
    return row.id;
};

const foldedAt = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    workerId: number,
    id: number,
): Promise<unknown> => {
    const row = (await db.engine_render_log.all<{ id: number; folded: string }>({ worker_id: workerId }))
        .find((candidate) => candidate.id === id);
    return JSON.parse(row?.folded ?? "null") as unknown;
};

test("new log entry defaults to no folded intervals", async () => {
    const { db, workerId } = await setup();
    try {
        assert.equal(await getFolded(db, workerId), "[]");
    } finally { await db.close(); }
});

test("KILL <1,-1> (log:///1/1/1) folds the complete body interval", async () => {
    const context = await setup();
    const { db, workerId } = context;
    try {
        const r = await new Log().kill("/1/1/1", WHOLE, ctxOf(context));
        assert.equal(r.status, 200);
        assert.equal(r.matched, 1);
        assert.equal(await getFolded(db, workerId), "[[1,-1]]");
    } finally { await db.close(); }
});

test("a scoped KILL accepts the canonical /OP suffix", async () => {
    const context = await setup();
    const { db, workerId } = context;
    try {
        const r = await new Log().kill("/1/1/1/EDIT", WHOLE, ctxOf(context));
        assert.equal(r.status, 200);
        assert.equal(await getFolded(db, workerId), "[[1,-1]]");
    } finally { await db.close(); }
});

test("a scoped KILL rejects a supplied /OP suffix that disagrees with the addressed row", async () => {
    const context = await setup();
    const { db, workerId } = context;
    try {
        const r = await new Log().kill("/1/1/1/READ", WHOLE, ctxOf(context));
        assert.equal(r.status, 404);
        assert.equal(await getFolded(db, workerId), "[]", "a discordant address cannot curate the row");
    } finally { await db.close(); }
});

test("a typed entry-materialization row resolves by its projected /READ suffix, not its durable EDIT event", async () => {
    const accepted = await setup('{"kind":"entry_materialized"}');
    try {
        assert.equal((await new Log().kill("/1/1/1/READ", WHOLE, ctxOf(accepted))).status, 200);
    } finally { await accepted.db.close(); }

    const rejected = await setup('{"kind":"entry_materialized"}');
    try {
        assert.equal((await new Log().kill("/1/1/1/EDIT", WHOLE, ctxOf(rejected))).status, 404);
    } finally { await rejected.db.close(); }
});

test("a scoped KILL is a friendly visibility no-op on a valid bodyless entry", async () => {
    const context = await setup("{}", "");
    const { db, workerId } = context;
    try {
        const log = new Log();
        const first = await log.kill("/1/1/1", WHOLE, ctxOf(context));
        assert.equal(first.status, 200);
        assert.equal(first.matched, 1);
        assert.equal(await getFolded(db, workerId), "[]", "a bodyless row has no hidden line interval");
        const again = await log.kill("/1/1/1", WHOLE, ctxOf(context));
        assert.equal(again.status, 200);
        assert.equal(again.matched, 1);
        assert.equal(await getFolded(db, workerId), "[]");
    } finally { await db.close(); }
});

test("scoped KILLs compose one way: numeric and hash-selected intervals accumulate", async () => {
    const context = await setup();
    const { db, workerId } = context;
    try {
        const content = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
        const id = await seedRead(context, 2, content);
        const log = new Log();

        const numeric = await log.kill("/1/1/2/READ", { marks: [3, 5] }, ctxOf(context));
        assert.equal(numeric.status, 200);
        assert.deepEqual(await foldedAt(db, workerId, id), [[3, 5]]);

        const anchor = LineAnchors.token("log:///1/1/2/READ", 7, content);
        const anchored = await log.kill("/1/1/2/READ", { marks: [anchor] }, ctxOf(context));
        assert.equal(anchored.status, 200);
        assert.deepEqual(await foldedAt(db, workerId, id), [[3, 5], [7, 7]], "the second interval joins the first; nothing reopens");

        const inside = await log.kill("/1/1/2/READ", { marks: [4] }, ctxOf(context));
        assert.equal(inside.status, 200);
        assert.deepEqual(await foldedAt(db, workerId, id), [[3, 5], [7, 7]], "a line already folded is a stable no-op");
    } finally { await db.close(); }
});

test("bulk scoped KILL intersects one scope with every selected canonical body", async () => {
    const context = await setup();
    const { db, workerId } = context;
    try {
        const shortId = await seedRead(context, 2, "short\nbody");
        const longId = await seedRead(
            context,
            3,
            Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
        );
        const result = await new Log().kill("/**/READ", { marks: [17, -1] }, ctxOf(context));
        assert.equal(result.status, 200);
        assert.equal(result.matched, 2, "row selection is independent of each body's scope intersection");
        assert.deepEqual(await foldedAt(db, workerId, shortId), [], "an absent range is a successful no-op");
        assert.deepEqual(await foldedAt(db, workerId, longId), [[17, -1]]);
    } finally { await db.close(); }
});

test("a matcher body selects the rows a scoped KILL curates", async () => {
    const context = await setup();
    const { db, workspaceId, workerId, loopId, turnId } = context;
    try {
        await seedRead(context, 2, "retain this row");
        await seedRead(context, 3, "discard this row");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.dispatch({
            statement: killStmt(urlPath("log", "/**/READ"), WHOLE, regex("retain")),
            workspaceId, workerId, loopId, turnId, sequence: 4, origin: "model",
        });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal((result as { matched?: number }).matched, 1);
        assert.equal(await getFolded(db, workerId, 2), "[[1,-1]]", "the matching READ row is folded");
        assert.equal(await getFolded(db, workerId, 3), "[]", "the non-matching READ row remains open");
        assert.equal(await getFolded(db, workerId, 1), "[]", "the non-matching EDIT (1/1/1) is untouched");
    } finally { await db.close(); }
});

test("KILL on a nonexistent coordinate returns 404, scoped or whole", async () => {
    const context = await setup();
    const { db } = context;
    try {
        assert.equal((await new Log().kill("/9/9/9", WHOLE, ctxOf(context))).status, 404);
        assert.equal((await new Log().kill("/9/9/9", null, ctxOf(context))).status, 404);
    } finally { await db.close(); }
});

test("KILL on a malformed path returns 400", async () => {
    const context = await setup();
    const { db } = context;
    try {
        assert.equal((await new Log().kill("/garbage", WHOLE, ctxOf(context))).status, 400);
    } finally { await db.close(); }
});

test("engine_render_log carries the delta source; self-authored entries stay null", async () => {
    const { db, workerId, loopId, turnId } = await setup();
    try {
        // A synthetic environment-delta row ({§env-delta}): origin=_plurnk, source=a scheme.
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId,
            sequence: 2, origin: "_plurnk", source: "file", model_call_id: null,
            op: "EDIT", delimiter: "",
            scheme: "file", username: null, password: null, hostname: null, port: null,
            pathname: "/config.toml", query: null, fragment: null, lineMarker: null,
            tx: "### EDIT0 (file:///config.toml)", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
            status_rx: 200, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const rows = await db.engine_render_log.all<{ sequence: number; source: string | null }>({ worker_id: workerId });
        assert.equal(rows.find((r) => r.sequence === 2)?.source, "file", "the delta's cause round-trips the render query → packet-wire renders source=\"file\"");
        assert.equal(rows.find((r) => r.sequence === 1)?.source, null, "a self-authored entry has null source — rendered without a worker= label");
    } finally { await db.close(); }
});

test("log curation honors segment-local `*` and recursive `**`", async () => {
    const context = await setup();
    const { db, workerId } = context;
    try {
        const log = new Log();

        const shallow = await log.kill("/*", WHOLE, ctxOf(context));
        assert.equal(shallow.status, 204, "no row lives directly at the log root");
        assert.equal(await getFolded(db, workerId), "[]", "`*` does not cross coordinate separators");

        const turnRows = await log.kill("/1/1/*", WHOLE, ctxOf(context));
        assert.equal(turnRows.status, 200, "the documented loop/turn/item hierarchy reaches rows with one star");
        assert.equal(turnRows.matched, 1);
        assert.equal(await getFolded(db, workerId), "[[1,-1]]", "the rendered /OP decoration is not a mandatory hierarchy level");

        const recursive = await log.kill("/**", WHOLE, ctxOf(context));
        assert.equal(recursive.status, 200);
        assert.equal(await getFolded(db, workerId), "[[1,-1]]", "`**` reaches recursive log rows");
    } finally { await db.close(); }
});

// {§turn-ops-log-curation}
test("KILL retires the addressed row from the active projection without erasing history", async () => {
    const context = await setup();
    const { db, workerId } = context;
    try {
        const log = new Log();
        await db.log_write_tag.run({ log_entry_id: 1, tag: "obsolete" });
        assert.equal(await getFolded(db, workerId), "[]", "row exists before KILL");
        const r = await log.kill("/1/1/1", null, ctxOf(context));
        assert.equal(r.status, 200, "KILL on a log item succeeds");
        assert.equal(r.matched, 1, "the receipt reports the exact active target count");
        assert.deepEqual(
            await db.test_get_log_projection.get({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 1 }),
            { id: 1, active: 0, folded: "[]" },
            "the durable row retains its projection state as inactive",
        );
        assert.deepEqual(
            await db.engine_render_log.all({ worker_id: workerId }),
            [],
            "the inactive row consumes no ordinary model-facing log projection",
        );
        assert.deepEqual(
            await db.test_log_tags_by_worker.all({ worker_id: workerId }),
            [{ coordinate: "1/1/1", tag: "obsolete" }],
            "KILL preserves the row's forensic classifications",
        );
        const catalog = await log.find(findStmt(urlPath("log", "/")), ctxOf(context));
        assert.equal(catalog.status, 200, "the catalog query itself succeeds");
        assert.deepEqual(catalog.results, [], "inactive evidence is absent from log FIND discovery");
        const repeated = await log.kill("/1/1/1", null, ctxOf(context));
        assert.equal(repeated.status, 404, "an exact killed coordinate is no longer addressable to ordinary curation");
    } finally { await db.close(); }
});

test("log selectors treat complete numeric bracket segments as inclusive intervals", async () => {
    const context = await setup();
    const { db, workerId, loopId, turnId } = context;
    try {
        const turns = [turnId];
        for (let turnSequence = 2; turnSequence <= 47; turnSequence += 1) {
            turns.push(await insertTurn(db, loopId, turnSequence));
        }
        for (const [index, candidateTurnId] of turns.entries()) {
            await db.engine_insert_log_entry.get({
                worker_id: workerId, loop_id: loopId, turn_id: candidateTurnId,
                sequence: index === 0 ? 2 : 1,
                origin: "model", source: null, model_call_id: null, op: "PLAN", delimiter: "",
                scheme: null, username: null, password: null, hostname: null, port: null,
                pathname: null, query: null, fragment: null, lineMarker: null,
                tx: JSON.stringify({ body: [] }), mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
                status_rx: 200, weight: 0, state: "resolved", outcome: null, attrs: "{}",
            });
        }

        const found = await new Log().find(
            { ...findStmt(urlPath("log", "/1/[35-46]/*/PLAN")), lineMarker: { marks: [1, -1] } },
            ctxOf(context),
        );
        assert.equal(found.status, 200);
        const foundPaths = found.results.flatMap((item) => Array.isArray(item)
            ? item.map(({ path }) => path)
            : []);
        assert.deepEqual(
            foundPaths,
            Array.from({ length: 12 }, (_, index) => `log:///1/${index + 35}/1/PLAN`),
            "FIND uses the same inclusive multi-digit interval as curation",
        );

        const killed = await new Log().kill("/1/[35-46]/*/PLAN", null, ctxOf(context));
        assert.equal(killed.status, 200);
        assert.equal(killed.matched, 12);
        const plans = await db.engine_render_log.all<{ turn_seq: number; op: string }>({ worker_id: workerId });
        assert.deepEqual(
            plans.filter(({ op }) => op === "PLAN").map(({ turn_seq }) => turn_seq),
            [...Array.from({ length: 34 }, (_, index) => index + 1), 47],
            "the range includes both boundaries and preserves adjacent turns",
        );

        const documented = await new Log().kill("/1/[1-7]/*/PLAN", null, ctxOf(context));
        assert.equal(documented.status, 200);
        assert.equal(documented.matched, 7);
        const remaining = await db.engine_render_log.all<{ turn_seq: number; op: string }>({ worker_id: workerId });
        assert.deepEqual(
            remaining.filter(({ op }) => op === "PLAN").map(({ turn_seq }) => turn_seq),
            [...Array.from({ length: 27 }, (_, index) => index + 8), 47],
            "the documented single-digit form is an interval too",
        );

        const repeated = await new Log().kill("/1/[35-46]/*/PLAN", null, ctxOf(context));
        assert.equal(repeated.status, 204, "a repeated broad KILL is a deterministic no-op");
        assert.equal(repeated.matched, 0);

        const reversed = await new Log().kill("/1/[46-35]/*/PLAN", null, ctxOf(context));
        assert.equal(reversed.status, 400, "a reversed numeric interval is malformed rather than an empty selection");
    } finally { await db.close(); }
});

test("KILL retires an op='error' item while preserving the durable failure record", async () => {
    const context = await setup();
    const { db, workerId, loopId, turnId } = context;
    try {
        // Seed an actionless op='error' row at 1/1/2 (the errors-into-log shape).
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 2,
            origin: "model", source: "grammar", model_call_id: null, op: "error", delimiter: "",
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ message: "parse error", snippet: "bad" }), mimetype_rx: "application/json",
            status_rx: 400, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const r = await new Log().kill("/1/1/2", null, ctxOf(context));
        assert.equal(r.status, 200, "an error row is KILLable exactly like any log item — no special-casing");
        const durable = await db.test_get_log_projection.get<{ active: number; folded: string }>({
            worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 2,
        });
        assert.deepEqual(durable, { id: 2, active: 0, folded: "[]" }, "forensics retain the killed error event");
        assert.equal(
            (await db.engine_render_log.all<{ id: number }>({ worker_id: workerId })).some(({ id }) => id === 2),
            false,
            "the killed error no longer reaches the packet or failure projection",
        );
    } finally { await db.close(); }
});

test("KILL <1,-1> (log:///1/1/) folds the turn's rows — the trailing slash means the contents, uniform with READ(folder/)", async () => {
    const context = await setup();
    const { db, workerId } = context;
    try {
        const r = await new Log().kill("/1/1/", WHOLE, ctxOf(context));
        assert.equal(r.status, 200);
        assert.equal(r.matched, 1, "the count of curated rows, clearly shown");
        assert.equal(await getFolded(db, workerId), "[[1,-1]]", "the turn's row folded");
    } finally { await db.close(); }
});

test("a zero-match sweep is a NO-OP SUCCESS — 204 with matched: 0, never an error", async () => {
    const context = await setup();
    const { db } = context;
    try {
        const r = await new Log().kill("/9/9/", WHOLE, ctxOf(context));
        assert.equal(r.status, 204, "204 stays OFF the errors surface — a sweep that found nothing steers nothing");
        assert.equal(r.matched, 0, "clearly shown");
        const star = await new Log().kill("/9/9/*", WHOLE, ctxOf(context));
        assert.equal(star.status, 204, "the explicit-glob form agrees");
    } finally { await db.close(); }
});

test("{§log-coordinate-hierarchy} a partial coordinate is a prefix with or without a trailing slash", async () => {
    const context = await setup();
    const { db, workerId } = context;
    try {
        // The natural whole-turn curation the jumbo model reached for (no trailing slash) resolves.
        const noSlash = await new Log().kill("/1/1", WHOLE, ctxOf(context));
        assert.equal(noSlash.status, 200, "log:///1/1 (no slash) curates turn 1/1 — no more 400");
        assert.equal(noSlash.matched, 1, "the turn's row");
        assert.equal(await getFolded(db, workerId), "[[1,-1]]");
        // And the loop prefix: log:///1 selects all of loop 1's rows.
        const loop = await new Log().kill("/1", WHOLE, ctxOf(context));
        assert.equal(loop.status, 200, "log:///1 curates loop 1's rows");
        assert.ok(Number(loop.matched) >= 1, "the loop prefix matched");
    } finally { await db.close(); }
});

test("a scoped KILL curates engine-minted error rows through the same operation coordinate grammar", async () => {
    const context = await setup();
    const { db, workerId, loopId, turnId } = context;
    try {
        // An engine-minted ERROR row (op='error', LOWERCASE) at seq=2. A
        // `[A-Z]+`-only coordinate suffix once made these rows incuratable.
        // Curation must work identically on every log row.
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 2,
            origin: "_plurnk", source: "rail", model_call_id: null, op: "error", delimiter: "",
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 429, kind: "max_commands_exceeded", message: "too many commands" }),
            mimetype_rx: "application/json", status_rx: 429, weight: 50, state: "failed", outcome: "max_commands_exceeded", attrs: "{}",
        });
        // The model's exact gesture — scope the error row away by its canonical operation address.
        const scoped = await new Log().kill("/1/1/2/error", WHOLE, ctxOf(context));
        assert.equal(scoped.status, 200, "an error row folds by coordinate — the model can reclaim budget by curating its OWN error rows");
        const folded = await db.test_get_log_folded.get<{ folded: string }>({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(folded?.folded, "[[1,-1]]", "the error row is folded away");
    } finally { await db.close(); }
});
