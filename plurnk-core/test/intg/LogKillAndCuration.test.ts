import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import Daemon from "../../src/server/Daemon.ts";
import Envelope from "../../src/server/envelope.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import { type ReadStatement, type UrlPath, type TextLineMarker, type PlurnkOp, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { type RepresentationPreparationRequest, type SchemeCtx, type SchemeHandler, type SchemeManifest } from "@plurnk/plurnk-schemes";
import { quiesceExecs } from "./_execs.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES, schemeManifest } from "./_scheme.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { urlPath, findStmt, killStmt, regex, editStmt, noteStmt, completeStmt } from "./_dsl.ts";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Digest } from "@plurnk/plurnk-digest";
import { fixtureExecutors } from "./_mock.ts";
import { type Executor } from "@plurnk/plurnk-execs";
import { logEntries, packetSection } from "./_packet.ts";
import { serverProposals } from "./_approval.ts";
import { parseLogRecords } from "../LogRecords.ts";


describe("Log.kill-scope", () => {
// {§log-kill-scope} — the log:/// scheme's curation surface is KILL on log:///N/T/S URIs.
// A whole-item KILL retires the row from the active projection; a scoped KILL suppresses one
// body interval for good (one-way: there is no inverse operation). Durable history is stored
// separately from the active/folded projection, and both are independent of
// entries+entry_channels. Log entries lack channels and many other entry properties
// but share the URI-dispatched curation mechanism.











const WHOLE: TextLineMarker = { marks: [1, -1] };

const setup = async (attrs = "{}", span = "body") => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    // Seed a log entry at coordinate (loop=1, turn=1, sequence=1).
    await db.engine_insert_log_entry.get({
        session_id: sessionId, loop_id: loopId, turn_id: turnId,
        sequence: 1,
        origin: "_plurnk",
        source: null,
        model_call_id: null,
        op: "EDIT",
        scheme: "workspace", username: null, password: null,
        hostname: null, port: null,
        pathname: "/x", query: null, fragment: null,
        lineMarker: null,
        tx: "````EDIT (workspace:///x)\nbody\n````", mimetype_tx: "text/vnd.plurnk",
        rx: JSON.stringify({ status: 201, ...(span.length === 0 ? {} : { span }) }), mimetype_rx: "application/json",
        status_rx: 201, weight: 0,
        state: "resolved", outcome: null, attrs,
    });
    return { db, workspaceId, sessionId, loopId, turnId };
};

const ctxOf = ({ db, workspaceId, sessionId, loopId, turnId }: Awaited<ReturnType<typeof setup>>) =>
    makeSchemeCtx({ db, workspaceId, sessionId, loopId, turnId, writer: "model" });

const getFolded = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number, sequence = 1): Promise<string | undefined> => {
    const row = await db.test_get_log_folded.get<{ folded: string }>({
        session_id: sessionId, loop_seq: 1, turn_seq: 1, sequence,
    });
    return row?.folded;
};

const seedRead = async ({ db, sessionId, loopId, turnId }: Awaited<ReturnType<typeof setup>>, sequence: number, content: string): Promise<number> => {
    const row = await db.engine_insert_log_entry.get<{ id: number }>({
        session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence,
        origin: "model", source: null, model_call_id: null, op: "READ",
        scheme: "workspace", username: null, password: null, hostname: null, port: null,
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
    sessionId: number,
    id: number,
): Promise<unknown> => {
    const row = (await db.engine_render_log.all<{ id: number; folded: string }>({ session_id: sessionId }))
        .find((candidate) => candidate.id === id);
    return JSON.parse(row?.folded ?? "null") as unknown;
};

test("{§log-kill-scope} new log entry defaults to no suppressed intervals", async () => {
    const { db, sessionId } = await setup();
    try {
        assert.equal(await getFolded(db, sessionId), "[]");
    } finally { await db.close(); }
});

test("{§log-kill-scope} KILL <1,-1> (log:///1/1/1) suppresses the complete body interval", async () => {
    const context = await setup();
    const { db, sessionId } = context;
    try {
        const r = await new Log().kill(killStmt(urlPath("log", "/1/1/1"), WHOLE), ctxOf(context));
        assert.equal(r.status, 200);
        assert.equal(r.matched, 1);
        assert.equal(await getFolded(db, sessionId), "[[1,-1]]");
    } finally { await db.close(); }
});

test("{§log-kill-scope} a scoped KILL accepts the canonical /OP suffix", async () => {
    const context = await setup();
    const { db, sessionId } = context;
    try {
        const r = await new Log().kill(killStmt(urlPath("log", "/1/1/1/EDIT"), WHOLE), ctxOf(context));
        assert.equal(r.status, 200);
        assert.equal(await getFolded(db, sessionId), "[[1,-1]]");
    } finally { await db.close(); }
});

test("{§log-kill-scope} a scoped KILL rejects a supplied /OP suffix that disagrees with the addressed row", async () => {
    const context = await setup();
    const { db, sessionId } = context;
    try {
        const r = await new Log().kill(killStmt(urlPath("log", "/1/1/1/READ"), WHOLE), ctxOf(context));
        assert.equal(r.status, 404);
        assert.equal(await getFolded(db, sessionId), "[]", "a discordant address cannot curate the row");
    } finally { await db.close(); }
});

test("{§log-kill-scope} a typed entry-materialization row resolves by its projected /READ suffix, not its durable EDIT event", async () => {
    const accepted = await setup('{"kind":"entry_materialized"}');
    try {
        assert.equal((await new Log().kill(killStmt(urlPath("log", "/1/1/1/READ"), WHOLE), ctxOf(accepted))).status, 200);
    } finally { await accepted.db.close(); }

    const rejected = await setup('{"kind":"entry_materialized"}');
    try {
        assert.equal((await new Log().kill(killStmt(urlPath("log", "/1/1/1/EDIT"), WHOLE), ctxOf(rejected))).status, 404);
    } finally { await rejected.db.close(); }
});

test("{§log-kill-scope} a scoped KILL is a friendly visibility no-op on a valid bodyless entry", async () => {
    const context = await setup("{}", "");
    const { db, sessionId } = context;
    try {
        const log = new Log();
        const first = await log.kill(killStmt(urlPath("log", "/1/1/1"), WHOLE), ctxOf(context));
        assert.equal(first.status, 200);
        assert.equal(first.matched, 1);
        assert.equal(await getFolded(db, sessionId), "[]", "a bodyless row has no hidden line interval");
        const again = await log.kill(killStmt(urlPath("log", "/1/1/1"), WHOLE), ctxOf(context));
        assert.equal(again.status, 200);
        assert.equal(again.matched, 1);
        assert.equal(await getFolded(db, sessionId), "[]");
    } finally { await db.close(); }
});

test("{§log-kill-scope} scoped KILLs compose one way: numeric and hash-selected intervals accumulate", async () => {
    const context = await setup();
    const { db, sessionId } = context;
    try {
        const content = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
        const id = await seedRead(context, 2, content);
        const log = new Log();

        const numeric = await log.kill(killStmt(urlPath("log", "/1/1/2/READ"), { marks: [3, 5] }), ctxOf(context));
        assert.equal(numeric.status, 200);
        assert.deepEqual(await foldedAt(db, sessionId, id), [[3, 5]]);

        const anchor = LineAnchors.token("log:///1/1/2/READ", 7, content);
        const anchored = await log.kill(killStmt(urlPath("log", "/1/1/2/READ"), { marks: [anchor] }), ctxOf(context));
        assert.equal(anchored.status, 200);
        assert.deepEqual(await foldedAt(db, sessionId, id), [[3, 5], [7, 7]], "the second interval joins the first; suppression is monotonic");

        const inside = await log.kill(killStmt(urlPath("log", "/1/1/2/READ"), { marks: [4] }), ctxOf(context));
        assert.equal(inside.status, 200);
        assert.deepEqual(await foldedAt(db, sessionId, id), [[3, 5], [7, 7]], "a line already suppressed is a stable no-op");
    } finally { await db.close(); }
});

test("{§log-history-projection} bulk scoped KILL intersects one scope with every selected canonical body", async () => {
    const context = await setup();
    const { db, sessionId } = context;
    try {
        const shortId = await seedRead(context, 2, "short\nbody");
        const longId = await seedRead(
            context,
            3,
            Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
        );
        const result = await new Log().kill(killStmt(urlPath("log", "/**/READ"), { marks: [17, -1] }), ctxOf(context));
        assert.equal(result.status, 200);
        assert.equal(result.matched, 2, "row selection is independent of each body's scope intersection");
        assert.deepEqual(await foldedAt(db, sessionId, shortId), [], "an absent range is a successful no-op");
        assert.deepEqual(await foldedAt(db, sessionId, longId), [[17, -1]]);
    } finally { await db.close(); }
});

test("{§log-kill-scope} a matcher body selects the rows a scoped KILL curates", async () => {
    const context = await setup();
    const { db, workspaceId, sessionId, loopId, turnId } = context;
    try {
        await seedRead(context, 2, "retain this row");
        await seedRead(context, 3, "discard this row");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.dispatch({
            statement: killStmt(urlPath("log", "/**/READ"), WHOLE, regex("retain")),
            workspaceId, sessionId, loopId, turnId, sequence: 4, origin: "model",
        });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal((result as { matched?: number }).matched, 1);
        assert.equal(await getFolded(db, sessionId, 2), "[[1,-1]]", "the matching READ row is body-suppressed");
        assert.equal(await getFolded(db, sessionId, 3), "[]", "the non-matching READ row remains visible");
        assert.equal(await getFolded(db, sessionId, 1), "[]", "the non-matching EDIT (1/1/1) is untouched");
    } finally { await db.close(); }
});

test("{§log-history-projection} an unscoped pattern KILL retires only the rows its pattern selects", async () => {
    const context = await setup();
    const { db, workspaceId, sessionId, loopId, turnId } = context;
    try {
        await seedRead(context, 2, "retain this row");
        await seedRead(context, 3, "discard this row");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.dispatch({
            statement: killStmt(urlPath("log", "/**/READ"), null, regex("discard")),
            workspaceId, sessionId, loopId, turnId, sequence: 4, origin: "model",
        });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal((result as { matched?: number }).matched, 1, "the pattern and the glob intersect; the glob alone does not decide");
        const active = async (sequence: number): Promise<number | undefined> =>
            (await db.test_log_entries_by_turn.all<{ sequence: number; active: number }>({ turn_id: turnId })).find((row) => row.sequence === sequence)?.active;
        assert.equal(await active(3), 0, "the matching READ row is retired");
        assert.equal(await active(2), 1, "the READ row the pattern does not select stays in context");
    } finally { await db.close(); }
});

test("{§log-kill-scope} KILL on a nonexistent coordinate returns 404, scoped or whole", async () => {
    const context = await setup();
    const { db } = context;
    try {
        assert.equal((await new Log().kill(killStmt(urlPath("log", "/9/9/9"), WHOLE), ctxOf(context))).status, 404);
        assert.equal((await new Log().kill(killStmt(urlPath("log", "/9/9/9"), null), ctxOf(context))).status, 404);
    } finally { await db.close(); }
});

test("{§log-kill-scope} KILL on a malformed path returns 400", async () => {
    const context = await setup();
    const { db } = context;
    try {
        assert.equal((await new Log().kill(killStmt(urlPath("log", "/garbage"), WHOLE), ctxOf(context))).status, 400);
    } finally { await db.close(); }
});

test("{§env-delta} engine_render_log carries the delta source; self-authored entries stay null", async () => {
    const { db, sessionId, loopId, turnId } = await setup();
    try {
        // A synthetic environment-delta row ({§env-delta}): origin=_plurnk, source=a scheme.
        await db.engine_insert_log_entry.get({
            session_id: sessionId, loop_id: loopId, turn_id: turnId,
            sequence: 2, origin: "_plurnk", source: "file", model_call_id: null,
            op: "EDIT",
            scheme: "file", username: null, password: null, hostname: null, port: null,
            pathname: "/config.toml", query: null, fragment: null, lineMarker: null,
            tx: "````EDIT (file:///config.toml)````", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
            status_rx: 200, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const rows = await db.engine_render_log.all<{ sequence: number; source: string | null }>({ session_id: sessionId });
        assert.equal(rows.find((r) => r.sequence === 2)?.source, "file", "the delta's cause round-trips the render query → packet-wire renders source=\"file\"");
        assert.equal(rows.find((r) => r.sequence === 1)?.source, null, "a self-authored entry has null source — rendered without a session= label");
    } finally { await db.close(); }
});

test("{§log-history-projection} log curation honors segment-local `*` and recursive `**`", async () => {
    const context = await setup();
    const { db, sessionId } = context;
    try {
        const log = new Log();

        const shallow = await log.kill(killStmt(urlPath("log", "/*"), WHOLE), ctxOf(context));
        assert.equal(shallow.status, 204, "no row lives directly at the log root");
        assert.equal(await getFolded(db, sessionId), "[]", "`*` does not cross coordinate separators");

        const turnRows = await log.kill(killStmt(urlPath("log", "/1/1/*"), WHOLE), ctxOf(context));
        assert.equal(turnRows.status, 200, "the documented loop/turn/item hierarchy reaches rows with one star");
        assert.equal(turnRows.matched, 1);
        assert.equal(await getFolded(db, sessionId), "[[1,-1]]", "the rendered /OP decoration is not a mandatory hierarchy level");

        const recursive = await log.kill(killStmt(urlPath("log", "/**"), WHOLE), ctxOf(context));
        assert.equal(recursive.status, 200);
        assert.equal(await getFolded(db, sessionId), "[[1,-1]]", "`**` reaches recursive log rows");
    } finally { await db.close(); }
});

// {§log-history-projection}
test("{§log-kill-scope} KILL retires the addressed row from the active projection without erasing history", async () => {
    const context = await setup();
    const { db, sessionId } = context;
    try {
        const log = new Log();
        assert.equal(await getFolded(db, sessionId), "[]", "row exists before KILL");
        const r = await log.kill(killStmt(urlPath("log", "/1/1/1"), null), ctxOf(context));
        assert.equal(r.status, 200, "KILL on a log item succeeds");
        assert.equal(r.matched, 1, "the receipt reports the exact active target count");
        assert.deepEqual(
            await db.test_get_log_projection.get({ session_id: sessionId, loop_seq: 1, turn_seq: 1, sequence: 1 }),
            { id: 1, active: 0, folded: "[]" },
            "the durable row retains its projection state as inactive",
        );
        assert.deepEqual(
            await db.engine_render_log.all({ session_id: sessionId }),
            [],
            "the inactive row consumes no ordinary model-facing log projection",
        );
        const catalog = await log.find(findStmt(urlPath("log", "/")), ctxOf(context));
        assert.equal(catalog.status, 200, "the catalog query itself succeeds");
        assert.deepEqual(catalog.results, [], "inactive evidence is absent from log FIND discovery");
        const read = await log.resolveCoreRepresentation(urlPath("log", "/1/1/1"), ctxOf(context));
        assert.ok("result" in read);
        assert.equal(read.result.status, 404, "inactive evidence is absent from exact model READ");
        const repeated = await log.kill(killStmt(urlPath("log", "/1/1/1"), null), ctxOf(context));
        assert.equal(repeated.status, 404, "an exact killed coordinate is no longer addressable to ordinary curation");
    } finally { await db.close(); }
});

test("{§log-kill-scope} log selectors treat complete numeric bracket segments as inclusive intervals", async () => {
    const context = await setup();
    const { db, sessionId, loopId, turnId } = context;
    try {
        const turns = [turnId];
        for (let turnSequence = 2; turnSequence <= 47; turnSequence += 1) {
            turns.push(await insertTurn(db, loopId, turnSequence));
        }
        for (const [index, candidateTurnId] of turns.entries()) {
            await db.engine_insert_log_entry.get({
                session_id: sessionId, loop_id: loopId, turn_id: candidateTurnId,
                sequence: index === 0 ? 2 : 1,
                origin: "model", source: null, model_call_id: null, op: "NOTE",
                scheme: null, username: null, password: null, hostname: null, port: null,
                pathname: null, query: null, fragment: null, lineMarker: null,
                tx: JSON.stringify({ body: "Retained note." }), mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
                status_rx: 200, weight: 0, state: "resolved", outcome: null, attrs: "{}",
            });
        }

        const found = await new Log().find(
            { ...findStmt(urlPath("log", "/1/[35-46]/*/NOTE")), lineMarker: { marks: [1, -1] } },
            ctxOf(context),
        );
        assert.equal(found.status, 200);
        const foundPaths = found.results.flatMap((item) => Array.isArray(item)
            ? item.map(({ path }) => path)
            : []);
        assert.deepEqual(
            foundPaths,
            Array.from({ length: 12 }, (_, index) => `log:///1/${index + 35}/1/NOTE`),
            "FIND uses the same inclusive multi-digit interval as curation",
        );

        const killed = await new Log().kill(killStmt(urlPath("log", "/1/[35-46]/*/NOTE"), null), ctxOf(context));
        assert.equal(killed.status, 200);
        assert.equal(killed.matched, 12);
        const plans = await db.engine_render_log.all<{ turn_seq: number; op: string }>({ session_id: sessionId });
        assert.deepEqual(
            plans.filter(({ op }) => op === "NOTE").map(({ turn_seq }) => turn_seq),
            [...Array.from({ length: 34 }, (_, index) => index + 1), 47],
            "the range includes both boundaries and preserves adjacent turns",
        );

        const documented = await new Log().kill(killStmt(urlPath("log", "/1/[1-7]/*/NOTE"), null), ctxOf(context));
        assert.equal(documented.status, 200);
        assert.equal(documented.matched, 7);
        const remaining = await db.engine_render_log.all<{ turn_seq: number; op: string }>({ session_id: sessionId });
        assert.deepEqual(
            remaining.filter(({ op }) => op === "NOTE").map(({ turn_seq }) => turn_seq),
            [...Array.from({ length: 27 }, (_, index) => index + 8), 47],
            "the documented single-digit form is an interval too",
        );

        const repeated = await new Log().kill(killStmt(urlPath("log", "/1/[35-46]/*/NOTE"), null), ctxOf(context));
        assert.equal(repeated.status, 204, "a repeated broad KILL is a deterministic no-op");
        assert.equal(repeated.matched, 0);

        const reversed = await new Log().kill(killStmt(urlPath("log", "/1/[46-35]/*/NOTE"), null), ctxOf(context));
        assert.equal(reversed.status, 400, "a reversed numeric interval is malformed rather than an empty selection");
    } finally { await db.close(); }
});

test("{§log-kill-scope} KILL retires an op='error' item while preserving the durable failure record", async () => {
    const context = await setup();
    const { db, sessionId, loopId, turnId } = context;
    try {
        // Seed an actionless op='error' row at 1/1/2 (the errors-into-log shape).
        await db.engine_insert_log_entry.get({
            session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence: 2,
            origin: "model", source: "grammar", model_call_id: null, op: "error",
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ message: "parse error", snippet: "bad" }), mimetype_rx: "application/json",
            status_rx: 400, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const r = await new Log().kill(killStmt(urlPath("log", "/1/1/2"), null), ctxOf(context));
        assert.equal(r.status, 200, "an error row is KILLable exactly like any log item — no special-casing");
        const durable = await db.test_get_log_projection.get<{ active: number; folded: string }>({
            session_id: sessionId, loop_seq: 1, turn_seq: 1, sequence: 2,
        });
        assert.deepEqual(durable, { id: 2, active: 0, folded: "[]" }, "forensics retain the killed error event");
        assert.equal(
            (await db.engine_render_log.all<{ id: number }>({ session_id: sessionId })).some(({ id }) => id === 2),
            false,
            "the killed error no longer reaches the packet or failure projection",
        );
    } finally { await db.close(); }
});

test("{§log-kill-scope} KILL <1,-1> (log:///1/1/) suppresses the turn's row bodies — the trailing slash means the contents, uniform with READ(folder/)", async () => {
    const context = await setup();
    const { db, sessionId } = context;
    try {
        const r = await new Log().kill(killStmt(urlPath("log", "/1/1/"), WHOLE), ctxOf(context));
        assert.equal(r.status, 200);
        assert.equal(r.matched, 1, "the count of curated rows, clearly shown");
        assert.equal(await getFolded(db, sessionId), "[[1,-1]]", "the turn's row body is suppressed");
    } finally { await db.close(); }
});

test("{§log-kill-scope} a zero-match sweep is a NO-OP SUCCESS — 204 with matched: 0, never an error", async () => {
    const context = await setup();
    const { db } = context;
    try {
        const r = await new Log().kill(killStmt(urlPath("log", "/9/9/"), WHOLE), ctxOf(context));
        assert.equal(r.status, 204, "204 stays OFF the errors surface — a sweep that found nothing steers nothing");
        assert.equal(r.matched, 0, "clearly shown");
        const star = await new Log().kill(killStmt(urlPath("log", "/9/9/*"), WHOLE), ctxOf(context));
        assert.equal(star.status, 204, "the explicit-glob form agrees");
    } finally { await db.close(); }
});

const SHAPE = /A log target is `log:\/\/\/<loop>\/<turn>\/<sequence>` with an optional `\/<op>` leaf; a shorter path is a prefix, and `\*`, `\*\*`, `\[1-7\]` or `\{a,b\}` may stand in any segment\./u;

test("{§log-kill-scope} a `|` between KILL targets lists them, bare or as full addresses, and one bad piece refuses the whole", async () => {
    const context = await setup();
    const { db } = context;
    try {
        await seedRead(context, 2, "two\n");
        await seedRead(context, 3, "three\n");
        const bad = await new Log().kill(killStmt(urlPath("log", "/1/1/2/READ|garbage"), null), ctxOf(context));
        assert.equal(bad.status, 400, "one unreadable piece refuses the whole list");
        assert.match(JSON.stringify(bad), /The log target 'garbage' is malformed\./u, "the piece is named");
        assert.match(JSON.stringify(bad), SHAPE, "the recovery is the shape");
        assert.equal(await db.test_log_entries_by_turn.all<{ active: number }>({ turn_id: context.turnId }).then((rows) => rows.filter((r) => r.active).length), 3, "nothing was retired");
        const list = await new Log().kill(killStmt(urlPath("log", "/1/1/2/READ|log:///1/1/3/READ"), null), ctxOf(context));
        assert.equal(list.status, 200, "a bare piece and a full address, as the model writes them");
        assert.equal(list.matched, 2, "the union");
        const sweep = await new Log().kill(killStmt(urlPath("log", "/1/1/2/READ|log:///9/*"), null), ctxOf(context));
        assert.equal(sweep.status, 204, "a list with a glob piece that selects nothing is the sweep's 204");
        const exact = await new Log().kill(killStmt(urlPath("log", "/1/1/2|1/1/3"), null), ctxOf(context));
        assert.equal(exact.status, 404, "every piece an exact coordinate and none active: the exact miss");
    } finally { await db.close(); }
});

test("{§log-kill-scope} the three near-miss shapes read exactly as the target they can only mean", async () => {
    const near = await setup();
    const canon = await setup();
    try {
        for (const context of [near, canon]) for (const [sequence, body] of [[2, "two\n"], [3, "three\n"], [4, "four\n"], [5, "five\n"]] as const) await seedRead(context, sequence, body);
        const pairs = [
            ["/1/1/2/*/READ", "/1/1/2/READ", "a `*` between the sequence and the leaf is dropped"],
            ["/1/1/[3,4]", "/1/1/{3,4}", "a bracketed comma list in a numeric slot is a set"],
            ["/1/READ", "/1/*/*/READ", "a leaf after one numeric slot fills the missing slots with `*`"],
        ] as const;
        for (const [written, canonical, why] of pairs) {
            const read = await new Log().kill(killStmt(urlPath("log", written), null), ctxOf(near));
            const meant = await new Log().kill(killStmt(urlPath("log", canonical), null), ctxOf(canon));
            assert.equal(meant.status, 200, `${canonical}: the canonical form selects rows`);
            assert.equal(read.status, meant.status, `${written}: ${why}`);
            assert.equal(read.matched, meant.matched, `${written} selects exactly what ${canonical} selects`);
        }
    } finally { await near.db.close(); await canon.db.close(); }
});

test("{§log-kill-scope} a sweep of nothing stays bare, and only a target nothing can read shows the coordinate shape", async () => {
    const context = await setup();
    const { db } = context;
    try {
        const bare = await new Log().kill(killStmt(urlPath("log", "/9/9/*"), null), ctxOf(context));
        assert.equal(bare.status, 204);
        assert.equal(bare.matched, 0);
        assert.equal(JSON.stringify(bare), '{"status":204,"matched":0}', "no text rides the packet for a sweep that matched nothing");
        for (const written of ["/garbage", "/1/READ/2"]) {
            const malformed = await new Log().kill(killStmt(urlPath("log", written), null), ctxOf(context));
            assert.equal(malformed.status, 400, `${written}: nothing can read it`);
            assert.match(JSON.stringify(malformed), SHAPE, `${written}: the refusal shows the shape`);
        }
    } finally { await db.close(); }
});

test("{§log-history-projection} a partial coordinate is a prefix with or without a trailing slash", async () => {
    const context = await setup();
    const { db, sessionId } = context;
    try {
        // The natural whole-turn curation the jumbo model reached for (no trailing slash) resolves.
        const noSlash = await new Log().kill(killStmt(urlPath("log", "/1/1"), WHOLE), ctxOf(context));
        assert.equal(noSlash.status, 200, "log:///1/1 (no slash) curates turn 1/1");
        assert.equal(noSlash.matched, 1, "the turn's row");
        assert.equal(await getFolded(db, sessionId), "[[1,-1]]");
        // And the loop prefix: log:///1 selects all of loop 1's rows.
        const loop = await new Log().kill(killStmt(urlPath("log", "/1"), WHOLE), ctxOf(context));
        assert.equal(loop.status, 200, "log:///1 curates loop 1's rows");
        assert.ok(Number(loop.matched) >= 1, "the loop prefix matched");
    } finally { await db.close(); }
});

test("{§log-kill-scope} a scoped KILL curates engine-minted error rows through the same operation coordinate grammar", async () => {
    const context = await setup();
    const { db, sessionId, loopId, turnId } = context;
    try {
        // An engine-minted ERROR row (op='error', LOWERCASE) at seq=2. A
        // `[A-Z]+`-only coordinate suffix once made these rows incuratable.
        // Curation must work identically on every log row.
        await db.engine_insert_log_entry.get({
            session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence: 2,
            origin: "_plurnk", source: "rail", model_call_id: null, op: "error",
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 429, kind: "max_commands_exceeded", message: "too many commands" }),
            mimetype_rx: "application/json", status_rx: 429, weight: 50, state: "failed", outcome: "max_commands_exceeded", attrs: "{}",
        });
        // The model's exact gesture — scope the error row away by its canonical operation address.
        const scoped = await new Log().kill(killStmt(urlPath("log", "/1/1/2/error"), WHOLE), ctxOf(context));
        assert.equal(scoped.status, 200, "an error row is suppressed by coordinate — the model can reclaim budget by curating its OWN error rows");
        const folded = await db.test_get_log_folded.get<{ folded: string }>({ session_id: sessionId, loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(folded?.folded, "[[1,-1]]", "the error row body is suppressed");
    } finally { await db.close(); }
});
});

describe("arrival-row-protection", () => {
// {§message-arrival}. Arrival rows are ordinary curatable log memory.








const urlLog = (raw: string) => ({ kind: "url" as const, raw, scheme: "log", username: null, password: null, hostname: null, port: null, pathname: "/" + raw.replace(/^log:\/\/\//, ""), query: null, fragment: null });
const urlSession = (raw: string) => ({ kind: "url" as const, raw, scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/" + raw.replace(/^workspace:\/\/\//, ""), query: null, fragment: null });

async function seedPromptSession(db: Awaited<ReturnType<typeof openMigrated>>) {
    const workspaceId = await insertWorkspace(db, `frame-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    // {§message-arrival}: the initial message has one inbound SEND row.
    await engine.runTurn({
        provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] } }] }),
        workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "Improve the module loader so require() stays deterministic." }],
    });
    const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
    if (next === undefined) throw new Error("next turn sequence unavailable");
    const curationTurn = await insertTurn(db, loopId, next.next, 102);
    return { workspaceId, sessionId, loopId, engine, curationTurn };
}

test("{§message-arrival} an explicit scoped KILL of the arrival row is ordinary curation", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, engine, curationTurn } = await seedPromptSession(db);
        // Turn 1 is initialization; the first model turn's arrival is turn 2, row 1.
        const r = await engine.dispatch({ statement: killStmt(urlLog("log:///1/2/1/SEND"), { marks: [1, -1] }), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 200, "the valid arrival row accepts scoped KILL like every other visible row");
        assert.equal((r as { matched?: number }).matched, 1);
        const visibility = await db.test_arrival_folded.get<{ folded: string }>({});
        assert.equal(visibility?.folded, "[[1,-1]]", "the explicit curation request is honored");
    } finally { await db.close(); }
});
test("{§message-arrival} prior and current loop arrivals share the same explicit curation contract", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, engine } = await seedPromptSession(db);
        // A second loop takes over; loop 1's arrival becomes curatable history.
        const loop2 = await insertLoop(db, sessionId, 2, "the next task");
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] } }] }),
            workspaceId, sessionId, loopId: loop2, messages: [{ role: "system", content: "SD" }, { role: "user", content: "the next task" }],
        });
        const curationTurn = await insertTurn(db, loop2, 2, 102);
        const stale = await engine.dispatch({ statement: killStmt(urlLog("log:///1/2/1/SEND"), { marks: [1, -1] }), workspaceId, sessionId, loopId: loop2, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.equal(stale.status, 200, "the old loop's arrival accepts scoped KILL");
        assert.equal((stale as { matched?: number }).matched, 1, "the KILL matched the stale arrival row - not a vacuous zero-match 200");
        // Loop 2 has no initialization, so its arrival is row 1.
        const current = await engine.dispatch({ statement: killStmt(urlLog("log:///2/1/1/SEND"), { marks: [1, -1] }), workspaceId, sessionId, loopId: loop2, turnId: curationTurn, sequence: 2, origin: "model" });
        assert.equal(current.status, 200, "the current arrival accepts scoped KILL under the same valid-row contract");
    } finally { await db.close(); }
});

test("{§message-arrival} KILL of the arrival remains deliberate curation", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, engine, curationTurn } = await seedPromptSession(db);
        const r = await engine.dispatch({ statement: killStmt(urlLog("log:///1/2/1/SEND")), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.ok(r.status < 400, `KILL of the arrival succeeds (deliberate) — got ${r.status}`);
    } finally { await db.close(); }
});

test("{§message-arrival} sister sessions' initial messages have independent inbox rows and publications", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `frame-sisters-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const mkProvider = () => new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] } }] });
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "the parent task");
        await engine.runTurn({ provider: mkProvider(), workspaceId, sessionId: parentSession, loopId: parentLoop, messages: [{ role: "system", content: "SD" }, { role: "user", content: "the parent task" }] });
        const childSession = await insertSession(db, workspaceId);
        const sessionLoop = await insertLoop(db, childSession, 1, "the session task");
        await engine.runTurn({ provider: mkProvider(), workspaceId, sessionId: childSession, loopId: sessionLoop, messages: [{ role: "system", content: "SD" }, { role: "user", content: "the session task" }] });

        const inboxOf = (loopId: number) => db.test_messages_by_loop.all<{ body: string; log_entry_id: number | null }>({ loop_id: loopId });
        const parentRows = await inboxOf(parentLoop);
        const sessionRows = await inboxOf(sessionLoop);
        assert.equal(parentRows.length, 1, "the parent's message exists in its own loop's inbox");
        assert.equal(sessionRows.length, 1, "the session's message exists in ITS loop's inbox");
        assert.equal(parentRows[0].body, "the parent task", "the session's turn-1 foist did not clobber the parent's task");
        assert.equal(sessionRows[0].body, "the session task");
        assert.ok(parentRows[0].log_entry_id !== null && sessionRows[0].log_entry_id !== null, "both were published");
        assert.notEqual(parentRows[0].log_entry_id, sessionRows[0].log_entry_id, "each became its own row");
    } finally { await db.close(); }
});

test("a scoped KILL is recorded in the DB but never renders ({§log-history-projection})", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, engine, curationTurn } = await seedPromptSession(db);
        // Seed a genuine non-arrival row (a workspace:/// note), then scoped-KILL it so the success records.
        await engine.dispatch({ statement: editStmt(urlSession("workspace:///scratch"), "note"), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: killStmt(urlLog("log:///1/3/1/EDIT"), { marks: [1, -1] }), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 2, origin: "model" });
        const dbRow = await db.test_count_op.get<{ n: number }>({ op: "KILL" });
        assert.ok((dbRow?.n ?? 0) >= 1, "the scoped KILL is recorded in the DB (forensics)");
        const rendered = await db.engine_render_log.all<{ op: string; status_rx: number }>({ session_id: sessionId });
        assert.ok(!rendered.some((r) => r.op === "KILL"), "the successful scoped KILL is absent immediately");
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        const laterTurn = await insertTurn(db, loopId, next!.next, 102);
        await engine.dispatch({ statement: editStmt(urlSession("workspace:///scratch2"), "later"), workspaceId, sessionId, loopId, turnId: laterTurn, sequence: 1, origin: "model" });
        const later = await db.engine_render_log.all<{ op: string }>({ session_id: sessionId });
        assert.ok(!later.some((r) => r.op === "KILL"), "the successful receipt remains absent on later turns");
        const stillRecorded = await db.test_count_op.get<{ n: number }>({ op: "KILL" });
        assert.equal(stillRecorded?.n, dbRow?.n, "history is append-only: the suppressed receipt remains in the DB");
    } finally { await db.close(); }
});

test("a successful log-item KILL never renders; a non-log KILL renders and stays ({§log-history-projection})", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, engine, curationTurn } = await seedPromptSession(db);
        // Two seeds: a workspace:/// note (a real artifact) and a log row to curate. KILL each.
        await engine.dispatch({ statement: editStmt(urlSession("workspace:///scratch"), "note"), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        // KILL the log EDIT row just written (active-context curation).
        const logKill = await engine.dispatch({ statement: killStmt(urlLog("log:///1/3/1/EDIT")), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 2, origin: "model" });
        assert.ok(logKill.status < 400, `KILL of the log item succeeds — got ${logKill.status}`);
        // KILL the workspace:/// note (a WORKSPACE mutation, not log housekeeping).
        const noteKill = await engine.dispatch({ statement: killStmt(urlSession("workspace:///scratch")), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 3, origin: "model" });
        assert.ok(noteKill.status < 400, `KILL of the note succeeds — got ${noteKill.status}`);

        const killCount = await db.test_count_op.get<{ n: number }>({ op: "KILL" });
        assert.ok((killCount?.n ?? 0) >= 2, "both KILLs are recorded in the DB (forensics)");

        const rendered = await db.engine_render_log.all<{ op: string; scheme: string | null }>({ session_id: sessionId });
        const killRows = rendered.filter((r) => r.op === "KILL");
        assert.ok(!killRows.some((r) => r.scheme === "log"), "the successful log-item KILL is absent immediately");
        assert.ok(killRows.some((r) => r.scheme === "workspace"), "the KILL of the session:// note — a workspace mutation — renders");
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        const laterTurn = await insertTurn(db, loopId, next!.next, 102);
        await engine.dispatch({ statement: editStmt(urlSession("workspace:///scratch3"), "later"), workspaceId, sessionId, loopId, turnId: laterTurn, sequence: 1, origin: "model" });
        const later = (await db.engine_render_log.all<{ op: string; scheme: string | null }>({ session_id: sessionId })).filter((r) => r.op === "KILL");
        assert.ok(!later.some((r) => r.scheme === "log"), "the log-item KILL receipt remains absent on later turns");
        assert.ok(later.some((r) => r.scheme === "workspace"), "the workspace-mutation KILL stays visible");
    } finally { await db.close(); }
});
});

describe("durable-log-redaction", () => {
const REDACTED = "__redacted__";
const STRUCTURAL_SECRETS = [
    "primary-user",
    "primary-password",
    "primary-header-secret",
    "secondary-header-secret",
    "copy-user",
    "copy-password",
    "move-user",
    "move-password",
] as const;

class CredentialProbe implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "credential-probe",
        channels: { body: "text/plain" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model"],
        volatile: false,
        modelVisible: true,
        metadataModifier: true,
    };

    observed: RepresentationPreparationRequest | null = null;

    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx) {
        if (request.target.kind !== "url") throw new Error("credential probe requires a URL target");
        this.observed = structuredClone(request);
        const written = await ctx.entries.write(request.pathname, {
            channels: {
                body: { content: "credential probe response", mimetype: "text/plain" },
            },
        });
        assert.ok(written.status === 200 || written.status === 201);
        return { status: 200 };
    }
}

const parseOperation = (source: string, op: PlurnkOp): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
    assert.equal(parsed.unparsedTail, undefined);
    const errors = parsed.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
    const statements = parsed.items.filter((item) => item.kind === "statement");
    assert.equal(statements.length, 1);
    const [item] = statements;
    if (item?.kind !== "statement") throw new Error(`No statement parsed from ${source}`);
    assert.equal(item.statement.op, op);
    return item.statement;
};

const assertNoStructuralSecrets = (value: unknown, surface: string): void => {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    for (const secret of STRUCTURAL_SECRETS) {
        assert.equal(
            serialized.includes(secret),
            false,
            `${surface} exposed structural credential ${secret}`,
        );
    }
};

const urlTarget = (statement: PlurnkStatement): UrlPath => {
    if (!("target" in statement) || statement.target?.kind !== "url") throw new Error(`${statement.op} did not retain a URL target`);
    return statement.target;
};

// {§log-history-projection}
test("{§log-history-projection} ordinary operation evidence redacts credential slots once before every durable projection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-log-redaction-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    let dbOpen = true;
    let daemon: Daemon | null = null;
    let daemonRunning = false;
    try {
        const workspaceId = await insertWorkspace(db, `log-redaction-${crypto.randomUUID()}`);
        const session = await Envelope.createModelSession(db, workspaceId, "redaction-parent");
        const loopId = await insertLoop(db, session.id, 1, "inspect durable evidence");
        const turnId = await insertTurn(db, loopId, 1, 200);
        const probe = new CredentialProbe();
        const schemes = new SchemeRegistry();
        schemes.register("credential-probe", probe);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });

        const read = parseOperation(
            "````READ (credential-probe://primary-user:primary-password@example.test/value?ticket=query-visible#body) [{\"Authorization\": \"Bearer primary-header-secret\", \"X-Api-Key\": \"secondary-header-secret\"}]````",
            "READ",
        );
        const copy = parseOperation(
            "````COPY (workspace:///missing-copy) (credential-probe://copy-user:copy-password@copy.test/destination?ticket=copy-query-visible)````",
            "COPY",
        );
        const move = parseOperation(
            "````MOVE (workspace:///missing-move) (credential-probe://move-user:move-password@move.test/destination?ticket=move-query-visible)````",
            "MOVE",
        );

        const statements = [read, copy, move] as const;
        const results = [];
        for (const [index, statement] of statements.entries()) {
            results.push(await engine.dispatch({
                statement,
                workspaceId,
                sessionId: session.id,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "model",
            }));
        }
        assert.equal(results[0]?.status, 200, "the successful operation reached its handler");
        assert.ok((results[1]?.status ?? 0) >= 400, "the COPY failure is durable error evidence");
        assert.ok((results[2]?.status ?? 0) >= 400, "the MOVE failure is durable error evidence");

        const observed = probe.observed;
        assert.ok(observed !== null);
        const observedTarget = observed.target;
        if (observedTarget.kind !== "url") throw new Error("credential probe lost its URL target");
        assert.equal(observedTarget.username, "primary-user");
        assert.equal(observedTarget.password, "primary-password");
        assert.deepEqual(observed.metadata, [
            '{"Authorization": "Bearer primary-header-secret", "X-Api-Key": "secondary-header-secret"}',
        ]);
        assert.equal(observedTarget.query, "ticket=query-visible");
        assert.equal(urlTarget(read).username, "primary-user", "the durable projection never mutates execution input");

        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }],
        });
        const nextTurn = await engine.runTurn({
            provider,
            workspaceId,
            sessionId: session.id,
            loopId,
            turnNumber: 2,
            messages: [],
        });
        const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: nextTurn.turnId });
        if (packetRow === undefined) throw new Error("next-turn packet was not persisted");
        assertNoStructuralSecrets(packetRow.packet, "assembled packet");
        assert.match(packetRow.packet, /ticket=query-visible/, "query identity remains visible by contract");

        daemon = new Daemon({ db, provider: null });
        await daemon.start();
        daemonRunning = true;
        const parentLog = await daemon.readLog({ workspaceId, sessionId: session.id, limit: 1000 });
        const readRow = parentLog.find((row) => row.op === "READ");
        if (readRow === undefined) throw new Error("READ operation row was not hydrated");
        assert.equal(readRow.username, REDACTED);
        assert.equal(readRow.password, REDACTED);
        assertNoStructuralSecrets(parentLog, "client log hydration");

        const readTx = readRow.tx as ReadStatement;
        const durableReadTarget = urlTarget(readTx);
        assert.equal(durableReadTarget.raw, "credential-probe://__redacted__:__redacted__@example.test/value?ticket=query-visible#body");
        assert.equal(durableReadTarget.username, REDACTED);
        assert.equal(durableReadTarget.password, REDACTED);
        assert.deepEqual(readTx.metadata, [REDACTED]);
        assert.equal(durableReadTarget.query, "ticket=query-visible");

        for (const op of ["COPY", "MOVE"] as const) {
            const row = parentLog.find((entry) => entry.op === op);
            if (row === undefined) throw new Error(`${op} operation row was not hydrated`);
            const tx = row.tx as PlurnkStatement;
            if (tx.op !== "COPY" && tx.op !== "MOVE") {
                throw new Error(`${op} durable statement lost its destination`);
            }
            const destination = tx.destination.target;
            if (destination.kind !== "url") throw new Error(`${op} destination is not a URL`);
            assert.equal(destination.username, REDACTED);
            assert.equal(destination.password, REDACTED);
            assert.match(destination.query ?? "", /-query-visible$/);
            assertNoStructuralSecrets(row, `${op} error row`);
        }

        const branch = await daemon.forkSession({
            workspaceId,
            sessionId: session.id,
            name: "redaction-branch",
        });
        const branchLog = await daemon.readLog({ workspaceId, sessionId: branch.sessionId, limit: 1000 });
        assertNoStructuralSecrets(branchLog, "forked log hydration");
        const branchRead = branchLog.find((row) => row.op === "READ");
        assert.equal(branchRead?.username, REDACTED);
        assert.equal(branchRead?.password, REDACTED);

        await daemon.stop();
        daemonRunning = false;
        await db.close();
        dbOpen = false;

        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const digestJson = await readFile(join(digestDir, "digest.json"), "utf8");
        const digestMarkdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assertNoStructuralSecrets(digestJson, "digest JSON");
        assertNoStructuralSecrets(digestMarkdown, "digest Markdown");
        assert.match(digestJson, /ticket=query-visible/, "digest retains non-secret query identity");
    } finally {
        if (daemonRunning && daemon !== null) await daemon.stop();
        if (dbOpen) await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
});

describe("executor-receipt-recovery", () => {
// {§exec-stream} {§log-kill-scope}: the executor is the fixture;
// parsing, dispatch, source storage, automatic observations and packet assembly are real.
for (const body of [null, '{"query":"fixture"}']) for (const mimetype of ["text/stream", "application/json"]) {
    test(`{§read} execution output stays reachable from the stream address a ${body === null ? "bodyless" : "one-line"} ${mimetype} invocation's receipt carries`, async () => {
        const output = Array.from({ length: 40 }, (_, index) => `result ${index + 1}`).join("\n");
        const executor: Executor = {
            runtime: "receiptfixture", glyph: "?",
            manifest: { ...schemeManifest("receiptfixture", { results: mimetype }, "results"), volatile: true },
            defaultChannel: "results", channels: { results: { mimetype } },
            effect: () => "pure",
            probe: async () => ({ available: true }),
            run: async (args) => {
                assert.equal(args.target, "inspect");
                assert.equal(args.body, body ?? "");
                args.write("results", output, "text/plain");
                return { status: 200, exitCode: 0 };
            },
        };
        const executors = new ExecutorRegistry(new Map([[executor.runtime, {
            executor, namespaceOwner: { kind: "module", name: "receipt fixture" },
            glyph: "?", summary: "Receipt fixture.", details: "", available: true, detail: undefined,
            invocation: {
                target: { role: "tool", required: true, kind: "literal" },
                body: { role: "JSON arguments", required: false },
                example: { target: "inspect", body: "{}" },
            },
        }]]));
        const db = await openMigrated();
        const schemes = new SchemeRegistry();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        try {
            const workspaceId = await insertWorkspace(db, "receipt-recovery");
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "Inspect the tool result.");
            const turn = async (program: string) => {
                const provider = new Mock({ contextWindow: 100_000,
                    responses: [{ assistant: { content: program, reasoning: null } }],
                });
                const result = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
                const stored = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
                assert.ok(stored, "the actual model request was persisted");
                const packet = JSON.parse(stored.packet);
                return { ...result, rows: logEntries(packet), replay: PacketWire.sectionContent(packet, "emission-history") };
            };
            const frame = PlurnkParser.frame;
            const observe = () => turn(frame("NOTE", "Inspect the recorded outcome."));
            const started = await turn(frame("receiptfixture (inspect)", body));
            assert.deepEqual(started.outcomes.map(({ op, status }) => [op, status]), [["receiptfixture", 200]]);
            await quiesceExecs(schemes);
            const detached = await new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined }).buildRequestPacket({
                workspaceId, sessionId, loopId, currentTurnSeq: 3,
                provider: new Mock({ contextWindow: 100_000, responses: [] }), initialMessages: [], gitStatus: null,
            });
            assert.equal(PacketWire.sectionContent(detached, "emission-history"), frame("receiptfixture (inspect)", body),
                "{§emission-history}: replay retains the complete invocation even after its executor is removed");
            assert.match(PacketWire.sectionContent(detached, "log"), /\/emission \(ops:\/\/[^\s)]+\/1\/2\) · \d+/u,
                "{§emission-history}: removing the runtime registration cannot erase an admitted invocation; its emission row and frozen program stand, parsed with the executors it was admitted with");
            const observed = await observe();
            const invocation = observed.rows.find((row) => row.logPath.endsWith("/receiptfixture"));
            assert.ok(invocation, "the real invocation has its own log identity");
            assert.equal(invocation.path, "inspect", "the receipt names the invoked tool, as its paired operation does");
            assert.ok(observed.replay.includes(frame("receiptfixture (inspect)", body)));
            assert.match(String(invocation.stream), /^receiptfixture:\/\/\/[a-f0-9]{8}$/u);
            assert.equal(invocation.lines, undefined, "argument bodies appear only in the complete operation, never as output");
            const automatic = observed.rows.find((row) => row.path === `${String(invocation.stream)}#results` && row.logPath.endsWith("/READ"));
            assert.ok(automatic, "the automatic output observation names the resource actually read");
            assert.equal(automatic.source, undefined);
            assert.equal(automatic.stream, undefined);
            assert.equal(automatic.range, "40 lines", "the automatic observation is a markerless READ: whole, because it fits ({§tokenomics})");
            assert.match(String(automatic.body), /40:result 40\n$/u);

            const mistaken = await turn(frame(`READ (${invocation.logPath}) <17,40>`, null));
            assert.equal(mistaken.outcomes[0]?.status, 416, "reading invocation arguments cannot retrieve execution output");
            const diagnosed = await observe();
            const failure = diagnosed.rows.find((row) => row.logPath.endsWith("/READ") && row.status === 416);
            assert.ok(failure, "the model sees the exact failed READ");
            assert.ok(diagnosed.replay.includes(frame(`READ (${invocation.logPath}) <17,40>`, null)));
            const problem = failure.problem as { range: { total: number }; stream?: string; recovery?: string };
            assert.equal(problem.range.total, body === null ? 0 : 1, "the diagnostic reports the invocation's true extent");
            const stream = body === null ? problem.stream : invocation.stream;
            assert.equal(stream, invocation.stream, "the receipt carries the exact advertised output address, without adding a channel");

            const recovered = await turn(frame(`READ (${String(stream)}) <17,40>`, null));
            assert.equal(recovered.outcomes[0]?.status, 200);
            const recovery = await observe();
            const read = recovery.rows.find((row) => row.logPath.endsWith("/READ") && row.origin === undefined && row.range === "<17,40> of 40 lines");
            assert.ok(read, "the explicit READ reaches the next model packet");
            assert.ok(recovery.replay.includes(frame(`READ (${String(stream)}) <17,40>`, null)));
            assert.equal(read.range, "<17,40> of 40 lines");
            assert.equal(read.terminal, true);
            assert.equal(read.exitCode, 0);
            assert.match(String(read.body), /40:result 40\n$/u);

            const revisited = await turn([
                frame(`KILL (${automatic.logPath})`, null),
                frame(`KILL (${read.logPath})`, null),
                frame(`READ (${String(stream)}) <1,-1>`, null),
            ].join("\n\n"));
            assert.deepEqual(revisited.outcomes.map(({ op, status }) => [op, status]),
                [["KILL", 200], ["KILL", 200], ["READ", 200]]);
            const afterCuration = await observe();
            assert.equal(afterCuration.rows.some((row) => row.logPath === automatic.logPath || row.logPath === read.logPath), false);
            const reread = afterCuration.rows.find((row) => row.logPath.endsWith("/READ") && row.origin === undefined && row.range === "40 lines");
            assert.ok(reread, "the retained output is still readable after its observations are curated away");
            assert.ok(afterCuration.replay.includes(frame(`READ (${String(stream)}) <1,-1>`, null)));
            assert.equal(reread.range, "40 lines");
            assert.match(String(reread.body), /1:result 1\n/u);
            assert.match(String(reread.body), /40:result 40\n$/u);
        } finally {
            await quiesceExecs(schemes);
            await schemes.close();
            await db.close();
        }
    });
}
});

describe("log-kill-distillation", () => {
// {§log-kill-scope}






const logSection = (packet: string): string => {
    return packetSection(JSON.parse(packet), "log");
};
const rows = (log: string, op: string): Array<Record<string, unknown>> =>
    parseLogRecords(log).filter(({ logPath: path }) => typeof path === "string" && path.endsWith(`/${op}`));

const distillation = "wcs.py: _array_converter returns early on empty input; the fix is its return path.";

test("{§log-kill-scope} a log KILL's body lands as the model's own NOTE row after the kill, named by what it distilled", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32768, responses: [
        "````EDIT (workspace:///note)\nfirst line\nsecond line\n````\n\n````READ (workspace:///note)````\n````NOTE\nwrote\n````",
        `\`\`\`\`KILL (log:///1/**/{READ,NOTE}) <!-- retire the read and the note; keep what they taught -->\n${distillation}\n\`\`\`\`\n\`\`\`\`KILL (log:///1/**/EDIT)\n   \n\`\`\`\`\n\`\`\`\`NOTE\ncurated\n\`\`\`\``,
        "````NOTE\nmoving on\n````",
        "````SEND [200]\ndone\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-kill-distillation" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "curate" });
            assert.equal(result.result.status, 200);
            const ids = result.turnIds ?? [];
            assert.ok(ids.length >= 5, `init + four model turns; got ${ids.length}`);
            const afterCuration = logSection((await db.test_get_packet.get<{ packet: string }>({ id: ids[3] }))!.packet);
            const notes = rows(afterCuration, "NOTE");
            assert.deepEqual(notes.map(({ body }) => body), [`1:${distillation}\n`, undefined], "distillation remains bodied; the authored NOTE is paired with its replay");
            assert.match(afterCuration, /### log:\/\/\/1\/3\/\d+\/NOTE · \d+/u, "the curating turn's NOTE keeps its receipt");
            assert.equal(rows(afterCuration, "KILL").length, 0, "both kills succeeded, so neither receipt renders");
            assert.equal(rows(afterCuration, "READ").length, 0);
            const history = await db.test_log_entries_by_loop.all<{
                op: string | null; pathname: string | null; sequence: number; turn_id: number; status_rx: number; rx: string; attrs: string | null; tx: string; origin: string;
            }>({ loop_id: result.loopId });
            // Sequence 1 of a model turn is the engine's ops:// echo of the emission; the model's rows follow it.
            const curation = history.filter(({ turn_id, origin }) => turn_id === ids[2] && origin === "model");
            assert.deepEqual(curation.map(({ op, pathname, sequence, status_rx }) => ({ op, pathname, sequence, status_rx })), [
                { op: "KILL", pathname: "/1/**/{READ,NOTE}", sequence: 2, status_rx: 200 },
                { op: "NOTE", pathname: null, sequence: 3, status_rx: 200 },
                { op: "KILL", pathname: "/1/**/EDIT", sequence: 4, status_rx: 200 },
                { op: "NOTE", pathname: null, sequence: 5, status_rx: 200 },
            ], "the distillation is written at the next sequence after its kill; a whitespace body is a plain KILL; later rows follow in order");
            const [kill, note, plainKill] = curation;
            assert.equal((JSON.parse(kill.tx) as { body: string | null }).body, distillation, "the kill's own record keeps the body it was emitted with");
            assert.deepEqual(JSON.parse(note.attrs ?? "{}"), { distilled: "log:///1/**/{READ,NOTE}" }, "the NOTE row names the selection it distilled");
            assert.equal((JSON.parse(note.tx) as { op: string; body: string }).body, distillation);
            assert.equal((JSON.parse(plainKill.tx) as { body: string | null }).body, null, "whitespace is no distillation");
            const programs = await db.test_turn_sources.all<{ kind: string; turn_id: number; content: string }>({ session_id: result.modelSessionId! });
            assert.ok(programs.some(({ kind, turn_id, content }) => kind === "note" && turn_id === ids[2] && content === distillation),
                "the distillation is retained as a note source exactly as a NOTE's body is");
        } finally { ws.close(); }
    });
});

test("{§log-kill-scope} a failed log KILL still keeps its body as the model's NOTE, named by the target as written; the miss is the receipt beside it", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32768, responses: [
        "````NOTE\nwrote\n````",
        "````KILL (log:///9/9/9)\nnothing here\n````\n````NOTE\nchecked\n````",
        "````SEND [200]\ndone\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-kill-distillation-miss" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "curate" });
            assert.equal(result.result.status, 200);
            const ids = result.turnIds ?? [];
            const history = await db.test_log_entries_by_loop.all<{
                op: string | null; pathname: string | null; sequence: number; turn_id: number; status_rx: number; attrs: string | null; tx: string; origin: string;
            }>({ loop_id: result.loopId });
            const curation = history.filter(({ turn_id, origin }) => turn_id === ids[2] && origin === "model");
            assert.deepEqual(curation.map(({ op, pathname, sequence, status_rx }) => ({ op, pathname, sequence, status_rx })), [
                { op: "KILL", pathname: "/9/9/9", sequence: 2, status_rx: 404 },
                { op: "NOTE", pathname: null, sequence: 3, status_rx: 200 },
                { op: "NOTE", pathname: null, sequence: 4, status_rx: 200 },
            ], "the miss is the receipt, and the body still lands as the NOTE after it");
            const [, kept] = curation;
            assert.deepEqual(JSON.parse(kept.attrs ?? "{}"), { distilled: "log:///9/9/9" }, "the NOTE names the target as written, hit or miss");
            assert.equal((JSON.parse(kept.tx) as { body: string }).body, "nothing here");
            const next = logSection((await db.test_get_packet.get<{ packet: string }>({ id: ids[3] }))!.packet);
            assert.equal(rows(next, "KILL").length, 1, "a missed log KILL's receipt renders");
            assert.deepEqual(rows(next, "NOTE").map(({ body }) => body).slice(-2), ["1:nothing here\n", undefined], "distillation remains bodied beside the paired authored NOTE");
            assert.match(next, /### log:\/\/\/1\/2\/\d+\/NOTE · \d+[\s\S]*### log:\/\/\/1\/3\/\d+\/NOTE · \d+/u, "both authored NOTEs keep their handles");
        } finally { ws.close(); }
    });
});
});


describe("note-curation", () => {
for (const partial of [false, true]) {
    test(`{§emission-history} {§log-kill-scope}: ${partial ? "trimming" : "retiring"} a NOTE never resurrects its complete body in replay`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "note-curation");
        const sessionId = await insertSession(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, sessionId, 1, "Retain the useful finding.");
        const first = PlurnkParser.frame("NOTE", "Obsolete line.\nStill useful.");
        const second = PlurnkParser.frame("NOTE", "Another finding.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            `${first}\n\n${second}`,
            PlurnkParser.frame(`KILL (log:///1/2/3/NOTE)${partial ? " <1>" : ""}`, null),
            PlurnkParser.frame("SEND [200]", "Done."),
        ].map((content) => ({ assistant: { content, reasoning: null } })) });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
        assert.equal(result.result.status, 200);
        const before = provider.received[1];
        assert.deepEqual(before.filter(({ role }) => role === "assistant").map(chatMessageText), [`${first}\n\n${second}`], "the turn's NOTEs replay together");
        const after = provider.received[2];
        assert.deepEqual(after.filter(({ role }) => role === "assistant").map(chatMessageText), [second]);
        const user = after.filter(({ role }) => role === "user").map(chatMessageText).join("\n");
        assert.doesNotMatch(user, /Obsolete line\./u);
        assert.match(user, /### log:\/\/\/1\/2\/4\/NOTE · \d+/u, "the other NOTE retains its own curation handle");
        if (partial) {
            assert.match(user, /### log:\/\/\/1\/2\/3\/NOTE[^\n]*\n[^\n]*\n2:Still useful\./u);
        } else {
            assert.doesNotMatch(user, /### log:\/\/\/1\/2\/3\/NOTE|Still useful\./u);
        }
        const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
        assert.equal(source!.content, `${first}\n\n${second}`, "curation never rewrites source evidence");
    });
}
});

