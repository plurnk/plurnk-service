import test, { describe } from "node:test";
import Workspace from "../../src/schemes/Workspace.ts";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { type FindStatement, type ReadStatement, type EditStatement } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { executionAddress, testExecutors } from "./_execs.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { makeSchemeCtx, readLog, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { matchLocations } from "./_find.ts";
import { clientRead } from "./_client-read.ts";
import { waitForDb } from "./_rpc.ts";
import { type CatalogResource, type FindResult } from "../../src/schemes/_entry-find.ts";
import { urlPath, findStmt, readStmt } from "./_dsl.ts";


describe("Log.read", () => {
const logEditStmt = (pathname: string, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: urlPath("workspace", pathname),
    lineMarker: null, body,
    matcher: null, position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "test prompt");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, sessionId, loopId, turnId };
};

const insertActionless = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    envelope: { sessionId: number; loopId: number; turnId: number },
    sequence: number,
    kind: "emissionAttempt",
    content: string,
): Promise<void> => {
    await db.engine_insert_log_entry.get({
        session_id: envelope.sessionId,
        loop_id: envelope.loopId,
        turn_id: envelope.turnId,
        sequence,
        origin: "model",
        source: null,
        model_call_id: null,
        op: null,
        scheme: null,
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: null,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: "",
        mimetype_tx: "text/plain",
        rx: JSON.stringify({ status: 200, content, mimetype: "text/vnd.plurnk" }),
        mimetype_rx: "application/json",
        status_rx: 200,
        weight: content.length,
        state: "resolved",
        outcome: null,
        attrs: JSON.stringify({ kind }),
    });
};

// {§read} — a real dispatch writes its authored command text, so the
// bodiless and out-of-range observables are inserted directly, carrying the stream link the
// dispatcher would have recorded on an execution row.
const insertExecutionRow = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    envelope: { sessionId: number; loopId: number; turnId: number },
    sequence: number,
    attrs: Record<string, unknown>,
    body: string | null,
): Promise<void> => {
    await db.engine_insert_log_entry.get({
        session_id: envelope.sessionId,
        loop_id: envelope.loopId,
        turn_id: envelope.turnId,
        sequence,
        origin: "model",
        source: null,
        model_call_id: null,
        op: "sh",
        scheme: null,
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: null,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: body === null ? "" : JSON.stringify({ body }),
        mimetype_tx: body === null ? "text/plain" : "application/json",
        rx: "",
        mimetype_rx: "text/plain",
        status_rx: 200,
        weight: body === null ? 0 : body.length,
        state: "resolved",
        outcome: null,
        attrs: JSON.stringify(attrs),
    });
};

test("{§read} Log.read: EDIT op log entry returns its canonical effect receipt", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: logEditStmt("/france", "Paris"),
            workspaceId, sessionId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        const result = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/plain");
        assert.match(String(result.content), /^1<@[0-9A-Za-z]{5}>Paris$/, "storage envelope fields do not replace the model-facing edit result");
    } finally { db.close(); }
});

test("{§read} Log.read: an exact /OP delimiter must agree with the addressed row", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: logEditStmt("/france", "Paris"),
            workspaceId, sessionId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        const correct = await readLog(readStmt(urlPath("log", "/1/1/1/EDIT")), makeSchemeCtx({ db, workspaceId, sessionId }));
        const wrong = await readLog(readStmt(urlPath("log", "/1/1/1/READ")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(correct.status, 200);
        assert.equal(wrong.status, 404);
    } finally { db.close(); }
});

test("{§log-history-projection}: rejected attempts retain exact canonical leaves and shorthand addressing", async () => {
    const { db, sessionId, loopId, turnId, workspaceId } = await setup();
    try {
        await insertActionless(db, { sessionId, loopId, turnId }, 1, "emissionAttempt", "````NOTE\nContinue the task.\n````");
        await insertActionless(db, { sessionId, loopId, turnId }, 2, "emissionAttempt", "malformed response");
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });

        const ops = await readLog(readStmt(urlPath("log", "/1/1/1/attempt")), ctx);
        const attempt = await readLog(readStmt(urlPath("log", "/1/1/2/attempt")), ctx);
        assert.equal(ops.status, 200);
        assert.match(ops.content ?? "", /````NOTE/);
        assert.equal(attempt.status, 200);
        assert.equal(attempt.content, "malformed response");

        assert.equal(
            (await readLog(readStmt(urlPath("log", "/1/1/1")), ctx)).status,
            200,
            "the three-part exact-coordinate shorthand remains accepted",
        );
        assert.equal(
            (await readLog(readStmt(urlPath("log", "/1/1/1/READ")), ctx)).status,
            404,
            "a canonical leaf that disagrees with the durable type cannot address the row",
        );
    } finally {
        db.close();
    }
});

test("{§read} Log.read: each coordinate addresses its own canonical body", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: logEditStmt("/a", "1"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: logEditStmt("/b", "2"), workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model" });
        await engine.dispatch({ statement: logEditStmt("/c", "3"), workspaceId, sessionId, loopId, turnId, sequence: 3, origin: "model" });

        const r1 = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r2 = await readLog(readStmt(urlPath("log", "/1/1/2")), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r3 = await readLog(readStmt(urlPath("log", "/1/1/3")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.deepEqual(
            [r1.content, r2.content, r3.content].map((content) => String(content).replace(/^ *(\d+)<@[0-9A-Za-z]{5}>/, "$1:")),
            ["1:1", "1:2", "1:3"],
            "coordinates resolve their own receipts rather than a neighboring row",
        );
    } finally { db.close(); }
});

test("{§read} Log.read: cross-loop coordinates within a session resolve correctly", async () => {
    const { db, engine, workspaceId, sessionId, loopId: loop1, turnId: turn1 } = await setup();
    try {
        await engine.dispatch({ statement: logEditStmt("/from-loop-1", "x"), workspaceId, sessionId, loopId: loop1, turnId: turn1, sequence: 1, origin: "model" });

        const loop2 = await insertLoop(db, sessionId, 2, "second");
        const turn2 = await insertTurn(db, loop2, 1, 200);
        await engine.dispatch({ statement: logEditStmt("/from-loop-2", "y"), workspaceId, sessionId, loopId: loop2, turnId: turn2, sequence: 1, origin: "model" });

        const r1 = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r2 = await readLog(readStmt(urlPath("log", "/2/1/1")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.match(String(r1.content), /^1<@[0-9A-Za-z]{5}>x$/);
        assert.match(String(r2.content), /^1<@[0-9A-Za-z]{5}>y$/);
    } finally { db.close(); }
});

test("{§read} Log.read: 404 on missing coordinates", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const result = await readLog(readStmt(urlPath("log", "/99/99/99")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

test("{§read} Log.read: 400 on malformed coordinates", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        for (const bad of ["abc", "1/2", "1/2/3/READ/4", "x/y/z"]) {
            const result = await readLog(readStmt(urlPath("log", bad)), makeSchemeCtx({ db, workspaceId, sessionId }));
            assert.equal(result.status, 400, `path '${bad}' should return 400`);
        }
    } finally { db.close(); }
});

test("{§read} Log.read: core rejects a channel fragment before projecting an atomic log row", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: logEditStmt("/fact", "value"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
        const target = urlPath("log", "/1/1/1");
        const result = await readLog(readStmt({
            ...target,
            raw: `${target.raw}#body`,
            fragment: "body",
        }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 404);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/log/channel-not-found");
    } finally { db.close(); }
});

test("{§read} Log.read: 400 on null path", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const result = await readLog(readStmt(null), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 400);
    } finally { db.close(); }
});

test("{§read} Log.read: lineMarker <1> on a JSON result selects its first physical line", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: logEditStmt("/data.json", '{"status":201,"entryId":7,"channel":"body"}'), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: readStmt(urlPath("workspace", "/data.json")), workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model" });
        const whole = await readLog(
            readStmt(urlPath("log", "/1/1/2")),
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/2")), lineMarker: { marks: [1] } };
        const r = await readLog(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        assert.equal(r.startLine, 1);
        assert.equal(r.content, (whole.content ?? "").split(/\r\n|\r|\n/)[0]);
    } finally { db.close(); }
});

test("{§read} Log.read: a range miss carries the exact textual line extent", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: logEditStmt("/data.json", '{"status":201,"entryId":7,"channel":"body"}'), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: readStmt(urlPath("workspace", "/data.json")), workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model" });
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/2")), lineMarker: { marks: [99] } };
        const r = await readLog(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 416);
        assert.equal(r.content, null);
        const range = r.problem?.range as {
            unit?: string;
            requested?: [number, number];
            total?: number;
        };
        assert.equal(range.unit, "line");
        assert.equal(range.requested?.[0], 99);
        assert.ok(Number(range.total) > 0);
    } finally { db.close(); }
});

test("{§read} Log.find: an exact matcher returns flat locations and complete path/location counts", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: logEditStmt("/data.json", '{"status":201,"entryId":7,"channel":"body"}'), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: readStmt(urlPath("workspace", "/data.json")), workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model" });
        const stmt: FindStatement = {
            metadata: null,
            op: "FIND", aside: null, target: urlPath("log", "/1/1/2"), lineMarker: null,
            matcher: { dialect: "regex", raw: "/\"status\"/", pattern: "\"status\"", flags: "" }, body: null, position: { line: 1, column: 1 },
        };
        const r = await new Log().find(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.equal(r.results.length, 1);
        assert.deepEqual(matchLocations(r)[0]?.region, {
            startLine: 1,
            startColumn: 2,
            endLine: 1,
            endColumn: 10,
        });
        assert.equal(r.matchingPathCount, 1);
        assert.equal(r.matchLocationCount, 1);
        assert.equal(r.range?.unit, "matchLocation");
    } finally { db.close(); }
});

test("{§edit-result-receipt-projection} Log.read: a READ signal does not filter the addressed log resource", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: logEditStmt("/z", "v"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/1")), };
        const result = await readLog(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.match(String(result.content), /^1<@[0-9A-Za-z]{5}>v$/, "{§edit-result-receipt-projection} an EDIT row's body is its anchored landed context");
    } finally { db.close(); }
});

test("{§read} Log.find: body matcher selects the full projection before <L> projects text", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: logEditStmt("/data.json", '{"status":201,"entryId":7,"channel":"body"}'), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: readStmt(urlPath("workspace", "/data.json")), workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model" });
        // The matcher qualifies the complete JSON result. Because the target is
        // exact, <1> selects the first match location.
        const stmt: FindStatement = {
            metadata: null,
            op: "FIND", aside: null, target: urlPath("log", "/1/1/2"),
            lineMarker: { marks: [1, 1] },
            matcher: { dialect: "regex", raw: "/\\d+/", pattern: "\\d+", flags: "" }, body: null, position: { line: 1, column: 1 },
        };
        const r = await new Log().find(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 1);
        assert.equal(r.matchingPathCount, 1);
        assert.ok(r.matchLocationCount > 1);
        assert.equal(r.range?.unit, "matchLocation");
    } finally { db.close(); }
});

test("{§read} Log.find: a matcher FIND writes flat surgical coordinates", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await new Workspace().edit(
            { ...logEditStmt("/notes", "alpha\nbeta\ngamma"), target: { kind: "url", raw: "workspace:///notes", scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/notes", query: null, fragment: null } },
            makeSchemeCtx({ db, workspaceId, sessionId, loopId, turnId }),
        );
        const result = await engine.dispatch({
            statement: {
                metadata: null,
                op: "FIND", aside: null,
                target: { kind: "url", raw: "workspace:///notes", scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/notes", query: null, fragment: null },
                lineMarker: null,
                matcher: { dialect: "regex", raw: "/\\w+/g", pattern: "\\w+", flags: "g" }, body: null,
                position: { line: 1, column: 1 },
            },
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.rowsWritten ?? 1, 1);
        const r = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        const locations = JSON.parse(r.content ?? "[]") as Array<{ region?: unknown }>;
        assert.equal(locations.length, 3);
        assert.ok(locations.every(({ region }) => region !== undefined));
    } finally { db.close(); }
});

test("{§edit-result-receipt-projection} Log.read: dispatches correctly via Engine.dispatch routing to log scheme", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: logEditStmt("/known-fact", "knowledge"),
            workspaceId, sessionId, loopId, turnId,
            sequence: 1, origin: "model",
        });

        const result = await engine.dispatch({
            statement: readStmt(urlPath("log", "/1/1/1")),
            workspaceId, sessionId, loopId, turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal((result as unknown as { mimetype: string }).mimetype, "text/plain");
        assert.match((result as unknown as { content: string }).content, /^1<@[0-9A-Za-z]{5}>knowledge$/, "{§edit-result-receipt-projection}");
    } finally { db.close(); }
});

// {§channel-selection} (#502) — a channel READ on a log execution item is a miss the
// receipt can resolve: the stream shares the coordinate and lives at <runtime>:///…/sh#channel.
test("{§read} Log.read: #channel on an execution log item names the command's stream address in its 404", async () => {
    const { db, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        const schemes = new SchemeRegistry();
        const executors = await testExecutors();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        let logEntryId = 0;
        const dispatched = new Promise<number>((settle) => {
            void engine.dispatch({
                statement: {
                    metadata: null, runtime: "sh", aside: null,
                    target: null, lineMarker: null, body: "echo hello", position: { line: 1, column: 1 },
                },
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
                onDispatch: (id) => { logEntryId = id; settle(id); },
            }).then((result) => assert.equal(result.status, 200, "the command started"));
        });
        await dispatched;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        // The short command concludes, so the stream carries its output.
        await waitForDb(() => db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId }), (row) => row?.state === "resolved");

        const address = await executionAddress(db, turnId);
        const miss = await readLog(
            readStmt({ ...urlPath("log", "/1/1/1/sh"), raw: "log:///1/1/1/sh#stdout", fragment: "stdout" }),
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        assert.equal(miss.status, 404);
        assert.equal(miss.problem?.type, "https://problems.plurnk.xyz/scheme/log/channel-not-found");
        assert.equal(miss.problem?.requestedChannel, "stdout");
        assert.equal(miss.problem?.stream, address, "the receipt carries the stream link the row already records");
        assert.equal(miss.problem?.recovery, `READ ${address}#stdout for the command's stdout stream.`);
        assert.ok(miss.problem?.detail.includes(`${address}#stdout`));

        // The named address is real: the same READ against it returns the output.
        const stream = await clientRead(engine, db, {
            statement: readStmt({ ...urlPath("sh", new URL(address).pathname), raw: `${address}#stdout`, fragment: "stdout" }),
            workspaceId, sessionId,
        });
        assert.equal(stream.status, 200);
        assert.match(String((stream as { content?: unknown }).content), /hello/);
    } finally { db.close(); }
});

// {§read} — the range twin of the channel miss above: an empty-extent
// 416 on a log execution item names the recorded stream address, and that address reads.
test("{§read} Log.read: an empty-extent 416 on an execution log item carries the command's stream address", async () => {
    const { db, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        const schemes = new SchemeRegistry();
        const executors = await testExecutors();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        let logEntryId = 0;
        const dispatched = new Promise<number>((settle) => {
            void engine.dispatch({
                statement: {
                    metadata: null, runtime: "sh", aside: null,
                    target: null, lineMarker: null, body: "echo hello", position: { line: 1, column: 1 },
                },
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
                onDispatch: (id) => { logEntryId = id; settle(id); },
            }).then((result) => assert.equal(result.status, 200, "the command started"));
        });
        await dispatched;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        // The short command concludes, so the stream carries its output.
        await waitForDb(() => db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId }), (row) => row?.state === "resolved");

        // The bodiless sibling shares the real execution's stream link, the way a drained or
        // bodiless call receipt does while its output stays readable at the stream address.
        const address = await executionAddress(db, turnId, 1);
        await insertExecutionRow(db, { sessionId, loopId, turnId }, 2, { stream: address }, null);

        const miss = await readLog(
            { ...readStmt(urlPath("log", "/1/1/2/sh")), lineMarker: { marks: [2, 3] } },
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        assert.equal(miss.status, 416);
        assert.equal(miss.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.deepEqual(miss.problem?.range, { unit: "line", total: 0, requested: [2, 3] });
        assert.equal(miss.problem?.stream, address, "the receipt carries the stream link the row already records");
        assert.doesNotMatch(miss.problem?.recovery ?? "", /sh:\/\//u, "{§diagnostic-observation}: the stream is a fact on the receipt, not a remedy");
        assert.equal(miss.problem?.detail, "Range 2,3 cannot select from empty content.");
        assert.equal(miss.problem?.retryable, false);

        // The named address is real: the same READ against it returns the output.
        const stream = await clientRead(engine, db, {
            statement: readStmt({ ...urlPath("sh", new URL(address).pathname), raw: `${address}#stdout`, fragment: "stdout" }),
            workspaceId, sessionId,
        });
        assert.equal(stream.status, 200);
        assert.match(String((stream as { content?: unknown }).content), /hello/);
    } finally { db.close(); }
});

// {§read} — no recorded stream, no naming: the generic slicer problem
// is byte-identical, the condition the augmentation must not disturb.
test("{§slicer-text-algebra} Log.read: an empty-extent 416 without a recorded stream keeps the generic slicer problem", async () => {
    const { db, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await insertExecutionRow(db, { sessionId, loopId, turnId }, 1, {}, null);
        const miss = await readLog(
            { ...readStmt(urlPath("log", "/1/1/1/sh")), lineMarker: { marks: [2, 3] } },
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        assert.equal(miss.status, 416);
        assert.equal(miss.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.deepEqual(miss.problem?.range, { unit: "line", total: 0, requested: [2, 3] });
        assert.equal(Object.hasOwn(miss.problem ?? {}, "stream"), false);
        assert.equal(miss.problem?.recovery, "Choose a range within the available extent."); // {§slicer-text-algebra}
        assert.equal(miss.problem?.detail, "Range 2,3 cannot select from empty content.");
        assert.equal(miss.problem?.retryable, false);
    } finally { db.close(); }
});

// {§read} — an ordinary out-of-range miss against a real extent keeps
// the generic problem even when the row records a stream.
test("{§read} Log.read: an out-of-range 416 against a command row's invocation carries the stream (#759)", async () => {
    const { db, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await insertExecutionRow(db, { sessionId, loopId, turnId }, 1, { stream: "sh:///0badcafe" }, "one\ntwo");
        const miss = await readLog(
            { ...readStmt(urlPath("log", "/1/1/1/sh")), lineMarker: { marks: [9] } },
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        assert.equal(miss.status, 416);
        assert.equal(miss.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.deepEqual(miss.problem?.range, { unit: "line", total: 2, requested: [9, 9] });
        assert.equal(miss.problem?.stream, "sh:///0badcafe");
        assert.doesNotMatch(miss.problem?.recovery ?? "", /sh:\/\//u, "{§diagnostic-observation}: the stream is a fact on the receipt, not a remedy");
        assert.equal(miss.problem?.detail, "Line 9 is outside the available line range 1..2.");
    } finally { db.close(); }
});
});

describe("Log.find", () => {
// {§find} — FIND over the session's log rows, on the SAME source-agnostic primitive every
// entry scheme runs ({§find}). The jumbo forensic: the model ran
// `FIND(log:///**):/engine/i` six times — a canon-documented gesture — and got a
// bare 501 from the one scheme that sat outside the universal paradigm. These pin the uniform
// contract through the REAL dispatch: FIND(log) with content dialects, the hierarchy as scope, and
// exact FIND→READ navigation.













const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

const findEditStmt = (pathname: string, content: string): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: { kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname, query: null, fragment: null },
    lineMarker: null, matcher: null, body: content, position: { line: 1, column: 1 },
});
const resources = (result: FindResult): CatalogResource[] =>
    result.results.filter((item): item is CatalogResource => Array.isArray(item));
const paths = (result: FindResult): string[] => resources(result).map(([item]) => item.path);

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `logfind-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "test prompt");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    // Three rows: an EDIT ack (JSON dust), a READ result carrying prose, another EDIT.
    await engine.dispatch({ statement: findEditStmt("/notes.md", "the engine hums along"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
    await engine.dispatch({ statement: readStmt(urlPath("workspace", "/notes.md")), workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model" });
    await engine.dispatch({ statement: findEditStmt("/other.md", "nothing relevant"), workspaceId, sessionId, loopId, turnId, sequence: 3, origin: "model" });
    return { db, engine, workspaceId, sessionId, loopId, turnId };
};

test("{§find} FIND(log:///**):/regex/ matches log rows by CONTENT — the jumbo gesture works", async () => {
    const { db, sessionId, workspaceId } = await setup();
    try {
        const r = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/engine hums/", pattern: "engine hums", flags: "" }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(r.status, 200, "log speaks the universal FIND");
        const foundPaths = paths(r);
        // BOTH rows whose projection carries the phrase match: the EDIT's rx echoes the written
        // span, the READ's rx carries the retrieved content — FIND matches exactly what READ shows.
        assert.ok(foundPaths.includes("log:///1/1/2/READ"), "the READ-result row matches by its content");
        assert.ok(foundPaths.includes("log:///1/1/1/EDIT"), "the EDIT row matches too — its rx echoes the written span (the projection is the contract)");
        assert.ok(!foundPaths.some((x) => x.includes("/1/1/3/")), "the irrelevant row is excluded");
        assert.ok(resources(r).every(([item]) => (item.matchLocationCount ?? 0) > 0), "each selected row reports its addressable location count");
    } finally { await db.close(); }
});

test("{§find} a body-less FIND(log:///1/1) lists the turn's rows — the hierarchy is the scope", async () => {
    const { db, sessionId, workspaceId } = await setup();
    try {
        const r = await new Log().find(findStmt(urlPath("log", "/1/1")), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 3, "the turn's three rows, catalog-shaped");
        const projected = JSON.parse(r.content!) as Array<Array<Record<string, unknown>>>;
        assert.equal(projected[0]?.[0]?.tokens, resources(r)[0]?.[0].weight);
        assert.equal(Object.hasOwn(projected[0]?.[0] ?? {}, "weight"), false, "model projection translates internal weight once");
        assert.equal(r.content!.split("\n").length, r.results.length, "log FIND uses the same one-item-per-line rendering as entry FIND");
        assert.ok(paths(r).every((path) => /^log:\/\/\/1\/1\/\d+\//.test(path)), "each item carries log:///loop/turn/seq/OP");
        assert.ok(resources(r).every(([item]) => item.weight >= 0), "each default channel carries internal curation weight");
    } finally { await db.close(); }
});

test("{§log-history-projection}: FIND projects and filters actionless rows by their canonical leaves", async () => {
    const { db, sessionId, loopId, turnId, workspaceId } = await setup();
    try {
        for (const [sequence, kind, content] of [
            [4, "emissionAttempt", "````NOTE\nContinue the task.\n````"],
            [5, "emissionAttempt", "broken output"],
        ] as const) {
            await db.engine_insert_log_entry.get({
                session_id: sessionId,
                loop_id: loopId,
                turn_id: turnId,
                sequence,
                origin: "model",
                source: null,
                model_call_id: null,
                op: null,
                scheme: null,
                username: null,
                password: null,
                hostname: null,
                port: null,
                pathname: null,
                query: null,
                fragment: null,
                lineMarker: null,
                tx: "",
                mimetype_tx: "text/plain",
                rx: JSON.stringify({ status: 200, content, mimetype: "text/vnd.plurnk" }),
                mimetype_rx: "application/json",
                status_rx: 200,
                weight: content.length,
                state: "resolved",
                outcome: null,
                attrs: JSON.stringify({ kind }),
            });
        }
        const log = new Log();
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
        const turn = await log.find({ ...findStmt(urlPath("log", "/1/1")), lineMarker: { marks: [1, -1] } }, ctx);
        assert.ok(paths(turn).includes("log:///1/1/4/attempt"));
        assert.ok(paths(turn).includes("log:///1/1/5/attempt"));

        const ops = await log.find(findStmt(urlPath("log", "/**/attempt")), ctx);
        assert.deepEqual(paths(ops), ["log:///1/1/4/attempt", "log:///1/1/5/attempt"]);
        const wrong = await log.find(findStmt(urlPath("log", "/1/1/4/READ")), ctx);
        assert.equal(wrong.status, 404);
    } finally {
        await db.close();
    }
});

test("{§find} an exact body-less log FIND returns 404 when the resource does not exist", async () => {
    const { db, sessionId, workspaceId } = await setup();
    try {
        const result = await new Log().find(
            findStmt(urlPath("log", "/9/9/9/READ")),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(result.status, 404);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/log/entry-not-found");
        assert.equal(result.problem?.target, "log:///9/9/9/READ");
    } finally { await db.close(); }
});

test("{§find} an exact log FIND rejects a supplied /OP delimiter that disagrees with an existing row", async () => {
    const { db, sessionId, workspaceId } = await setup();
    try {
        const result = await new Log().find(
            findStmt(urlPath("log", "/1/1/1/READ")),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(result.status, 404);
        assert.equal(result.problem?.target, "log:///1/1/1/READ");
    } finally { await db.close(); }
});

test("{§packet} a markerless log FIND returns its first page of rows, every row when they fit; an explicit <1,-1> is the whole", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        for (let sequence = 4; sequence <= 20; sequence++) {
            await engine.dispatch({
                statement: findEditStmt(`/entry-${sequence}.md`, `row ${sequence}`),
                workspaceId,
                sessionId,
                loopId,
                turnId,
                sequence,
                origin: "model",
            });
        }
        const log = new Log();
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
        const whole = await log.find(findStmt(urlPath("log", "/1/1")), ctx);
        assert.equal(whole.results.length, 20);
        assert.equal(whole.range?.total, 20);
        assert.deepEqual(whole.range?.requested, [1, PAGE]);
        assert.deepEqual(whole.range?.returned, [1, 20]);
        assert.equal(whole.itemsWeightTotal, whole.returnedItemsWeightTotal, "nothing is held back");

        const all = await log.find({
            ...findStmt(urlPath("log", "/1/1")),
            lineMarker: { marks: [1, -1] },
        }, ctx);
        assert.equal(all.results.length, 20);
        assert.deepEqual(all.range?.returned, [1, 20]);
        assert.equal(all.itemsWeightTotal, all.returnedItemsWeightTotal);
    } finally { await db.close(); }
});

test("{§find} a single-star log FIND maps one coordinate level without crossing separators", async () => {
    const { db, sessionId, workspaceId } = await setup();
    try {
        const log = new Log();
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });

        const root = await log.find(findStmt(urlPath("log", "/*")), ctx);
        assert.equal(root.status, 200);
        assert.deepEqual(paths(root), ["log:///1/**"]);
        const loop = resources(root)[0]?.[0];
        assert.ok(loop !== undefined && "items" in loop && loop.items === 3 && loop.weight >= 0, "the loop scope summarizes its recursive rows");
        assert.equal(root.matchingPathCount, 0, "the summary is navigation metadata, not a hidden row match");

        const segmented = await log.find(findStmt(urlPath("log", "/*/*/*")), ctx);
        assert.equal(segmented.results.length, 3, "one star per canonical coordinate segment reaches the rows");
        assert.ok(paths(segmented).every((path) => /^log:\/\/\/1\/1\/\d+\//.test(path)));

        const turnRows = await log.find(findStmt(urlPath("log", "/1/1/*")), ctx);
        assert.equal(turnRows.results.length, 3, "a turn-level star lists its item resources rather than /OP decorations");

        const recursive = await log.find(findStmt(urlPath("log", "/**")), ctx);
        assert.equal(recursive.results.length, 3, "double-star remains the direct recursive row listing");
    } finally { await db.close(); }
});

test("{§find} FIND pagination misses carry the exact result extent", async () => {
    const { db, sessionId, workspaceId } = await setup();
    try {
        const statement = {
            ...findStmt(urlPath("log", "/1/1")),
            lineMarker: { marks: [9] as [number] },
        };
        const r = await new Log().find(statement, makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }));
        assert.equal(r.status, 416);
        assert.deepEqual(r.problem?.range, {
            unit: "resource",
            total: 3,
            requested: [9, 9],
        });
    } finally { await db.close(); }
});

test("{§find} log FIND reports an exact readable region for structural matches", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: findEditStmt("/data.json", '{\n  "first": 1,\n  "second": 2\n}'),
            workspaceId, sessionId, loopId, turnId, sequence: 4, origin: "model",
        });
        await engine.dispatch({
            statement: readStmt(urlPath("workspace", "/data.json")),
            workspaceId, sessionId, loopId, turnId, sequence: 5, origin: "model",
        });
        const result = await new Log().find(
            findStmt(urlPath("log", "/1/1/5/READ"), { dialect: "jsonpath", raw: "$.second" }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(result.status, 200);
        const match = matchLocations(result)[0];
        assert.equal(match?.locator, "$['second']");
        assert.equal(match?.region?.startLine, 3);
        assert.equal(match?.region?.endLine, 3);
        assert.ok((match?.region?.endColumn ?? 0) > (match?.region?.startColumn ?? 0));
    } finally { await db.close(); }
});

test("{§find} FIND(log:///**):/pattern/ — FIND locates matching log entries", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        const result = await engine.dispatch({
            statement: findStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/engine hums/", pattern: "engine hums", flags: "" }),
            workspaceId, sessionId, loopId, turnId, sequence: 4, origin: "model",
        });
        assert.equal(result.status, 200, "FIND locates log entries");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string; sequence: number }>({ loop_id: loopId });
        const delivered = rows.filter((r) => r.op === "FIND" && r.sequence >= 4);
        assert.ok(delivered.length >= 1, "the matching FIND row is recorded");
    } finally { await db.close(); }
});

test("{§find} READ(log://)<1,-1> returns a composed row's complete canonical body", async () => {
    const { db, sessionId, loopId, turnId, workspaceId } = await setup();
    try {
        const full = Array.from({ length: 30 }, (_, i) => `plan line ${i + 1}`).join("\n");
        await db.engine_insert_log_entry.get({
            session_id: sessionId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: 4,
            origin: "model",
            source: null,
            model_call_id: null,
            op: "NOTE",
            scheme: null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: null,
            query: null,
            fragment: null,
            lineMarker: null,
            tx: JSON.stringify({ body: full }),
            mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 200 }),
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: 0,
            state: "resolved",
            outcome: null,
            attrs: "{}",
        });

        const result = await readLog(
            { ...readStmt(urlPath("log", "/1/1/4/NOTE")), lineMarker: { marks: [1, -1] } },
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.content, full, "READ recovers the complete note text");
    } finally { await db.close(); }
});

test("{§find} zero content matches → 204; an unwarmed relation query fails with structured index state", async () => {
    const { db, sessionId, workspaceId } = await setup();
    try {
        const none = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/absent-phrase-xyz/", pattern: "absent-phrase-xyz", flags: "" }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(none.status, 204, "a sweep that found nothing steers nothing");
        const sem = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "fts", raw: "~engine" }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(sem.status, 503, "an advertised matcher is unavailable only while its persistent index is incomplete");
        assert.deepEqual(sem.problem?.search, { state: "incomplete", indexed: 0, total: 3 });
    } finally { await db.close(); }
});

test("{§find} full-text and graph FIND over logs use the same persistent derivations as entries", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: findEditStmt("/source.ts", "export function helper() { return 1; }\nexport function caller() { return helper(); }"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 4,
            origin: "model",
        });
        await engine.dispatch({
            statement: readStmt(urlPath("workspace", "/source.ts")),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 5,
            origin: "model",
        });
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }));

        const entryAttachment = await db.test_entry_deep_hash_by_path.get<{ deep_hash: string | null }>({
            workspace_id: workspaceId,
            scheme: "workspace",
            pathname: "/notes.md",
        });
        const logAttachment = await db.test_log_deep_hash_by_turn_sequence.get<{ deep_hash: string | null }>({
            turn_id: turnId,
            sequence: 2,
        });
        assert.ok(entryAttachment?.deep_hash);
        assert.equal(
            logAttachment?.deep_hash,
            entryAttachment.deep_hash,
            "identical entry and log READ projections attach the same immutable derivation artifact",
        );

        const fulltextStatement = findStmt(
            urlPath("log", "/**"),
            { dialect: "fts", raw: "~engine hums" },
        );
        const fulltext = await new Log().find(
            fulltextStatement,
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(fulltext.status, 200);
        assert.ok(paths(fulltext).some((path) => path.includes("/1/1/2/READ")),
            "full-text rank returns the log address whose READ projection carries the phrase");
        assert.ok(fulltext.results.length >= 2, "the full-text specimen has multiple ranked log results");
        const secondFulltext = await new Log().find(
            { ...fulltextStatement, lineMarker: { marks: [2] } },
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.deepEqual(
            paths(secondFulltext),
            paths(fulltext).slice(1, 2),
            "log full-text FIND uses the same positional result scope as every FIND",
        );

        const graph = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "graph", raw: "&<helper" }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(graph.status, 200);
        assert.ok(paths(graph).some((path) => path.includes("/1/1/5/READ")),
            "graph relation returns the log address whose readable code projection references helper");

        const graphMiss = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "graph", raw: "&<absentSymbol" }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(graphMiss.status, 204, "entry and log relation misses share the universal matcher status");
        assert.deepEqual(graphMiss.results, []);
    } finally { await db.close(); }
});
});

