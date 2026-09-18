import test from "node:test";
import Worker from "../../src/schemes/Worker.ts";
import assert from "node:assert/strict";
import type { FindStatement, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { executionAddress, openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, readLog, testExecutors, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { matchLocations } from "./_find.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const readStmt = (target: ParsedPath | null): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null, target,
    lineMarker: null, matcher: null, body: null,
    position: { line: 1, column: 1 },
});

const editStmt = (pathname: string, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: urlPath("worker", pathname),
    lineMarker: null, body,
    matcher: null, position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "test prompt");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, workerId, loopId, turnId };
};

const insertActionless = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    envelope: { workerId: number; loopId: number; turnId: number },
    sequence: number,
    kind: "emissionAttempt",
    content: string,
): Promise<void> => {
    await db.engine_insert_log_entry.get({
        worker_id: envelope.workerId,
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

// {§log-range-miss-names-stream} — a real dispatch writes its authored command text, so the
// bodiless and out-of-range observables are inserted directly, carrying the stream link the
// dispatcher would have recorded on an execution row.
const insertExecutionRow = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    envelope: { workerId: number; loopId: number; turnId: number },
    sequence: number,
    attrs: Record<string, unknown>,
    body: string | null,
): Promise<void> => {
    await db.engine_insert_log_entry.get({
        worker_id: envelope.workerId,
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

test("Log.read: EDIT op log entry returns its canonical effect receipt", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/france", "Paris"),
            workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        const result = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/plain");
        assert.match(String(result.content), /^@[0-9A-Za-z]{5} +1:Paris$/, "storage envelope fields do not replace the model-facing edit result");
    } finally { db.close(); }
});

test("Log.read: an exact /OP delimiter must agree with the addressed row", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/france", "Paris"),
            workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        const correct = await readLog(readStmt(urlPath("log", "/1/1/1/EDIT")), makeSchemeCtx({ db, workspaceId, workerId }));
        const wrong = await readLog(readStmt(urlPath("log", "/1/1/1/READ")), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(correct.status, 200);
        assert.equal(wrong.status, 404);
    } finally { db.close(); }
});

test("{§log-coordinate-hierarchy}: rejected attempts retain exact canonical leaves and shorthand addressing", async () => {
    const { db, workerId, loopId, turnId, workspaceId } = await setup();
    try {
        await insertActionless(db, { workerId, loopId, turnId }, 1, "emissionAttempt", "```NOTE\nContinue the task.\n```");
        await insertActionless(db, { workerId, loopId, turnId }, 2, "emissionAttempt", "malformed response");
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });

        const ops = await readLog(readStmt(urlPath("log", "/1/1/1/attempt")), ctx);
        const attempt = await readLog(readStmt(urlPath("log", "/1/1/2/attempt")), ctx);
        assert.equal(ops.status, 200);
        assert.match(ops.content ?? "", /```NOTE/);
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

test("Log.read: each coordinate addresses its own canonical body", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/a", "1"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt("/b", "2"), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        await engine.dispatch({ statement: editStmt("/c", "3"), workspaceId, workerId, loopId, turnId, sequence: 3, origin: "model" });

        const r1 = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, workerId }));
        const r2 = await readLog(readStmt(urlPath("log", "/1/1/2")), makeSchemeCtx({ db, workspaceId, workerId }));
        const r3 = await readLog(readStmt(urlPath("log", "/1/1/3")), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.deepEqual(
            [r1.content, r2.content, r3.content].map((content) => String(content).replace(/^@[0-9A-Za-z]{5} +/, "")),
            ["1:1", "1:2", "1:3"],
            "coordinates resolve their own receipts rather than a neighboring row",
        );
    } finally { db.close(); }
});

test("Log.read: cross-loop coordinates within a worker resolve correctly", async () => {
    const { db, engine, workspaceId, workerId, loopId: loop1, turnId: turn1 } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/from-loop-1", "x"), workspaceId, workerId, loopId: loop1, turnId: turn1, sequence: 1, origin: "model" });

        const loop2 = await insertLoop(db, workerId, 2, "second");
        const turn2 = await insertTurn(db, loop2, 1, 200);
        await engine.dispatch({ statement: editStmt("/from-loop-2", "y"), workspaceId, workerId, loopId: loop2, turnId: turn2, sequence: 1, origin: "model" });

        const r1 = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, workerId }));
        const r2 = await readLog(readStmt(urlPath("log", "/2/1/1")), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.match(String(r1.content), /^@[0-9A-Za-z]{5} +1:x$/);
        assert.match(String(r2.content), /^@[0-9A-Za-z]{5} +1:y$/);
    } finally { db.close(); }
});

test("Log.read: 404 on missing coordinates", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const result = await readLog(readStmt(urlPath("log", "/99/99/99")), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

test("Log.read: 400 on malformed coordinates", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        for (const bad of ["abc", "1/2", "1/2/3/READ/4", "x/y/z"]) {
            const result = await readLog(readStmt(urlPath("log", bad)), makeSchemeCtx({ db, workspaceId, workerId }));
            assert.equal(result.status, 400, `path '${bad}' should return 400`);
        }
    } finally { db.close(); }
});

test("Log.read: core rejects a channel fragment before projecting an atomic log row", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/fact", "value"),
            workspaceId,
            workerId,
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
        }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 404);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/log/channel-not-found");
    } finally { db.close(); }
});

test("Log.read: 400 on null path", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const result = await readLog(readStmt(null), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 400);
    } finally { db.close(); }
});

test("Log.read: lineMarker <1> on a JSON result selects its first physical line", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/data.json", '{"status":201,"entryId":7,"channel":"body"}'), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: readStmt(urlPath("worker", "/data.json")), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        const whole = await readLog(
            readStmt(urlPath("log", "/1/1/2")),
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/2")), lineMarker: { marks: [1] } };
        const r = await readLog(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        assert.equal(r.startLine, 1);
        assert.equal(r.content, (whole.content ?? "").split(/\r\n|\r|\n/)[0]);
    } finally { db.close(); }
});

test("Log.read: a range miss carries the exact textual line extent", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/data.json", '{"status":201,"entryId":7,"channel":"body"}'), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: readStmt(urlPath("worker", "/data.json")), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/2")), lineMarker: { marks: [99] } };
        const r = await readLog(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
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

test("Log.find: an exact matcher returns flat locations and complete path/location counts", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/data.json", '{"status":201,"entryId":7,"channel":"body"}'), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: readStmt(urlPath("worker", "/data.json")), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        const stmt: FindStatement = {
            metadata: null,
            op: "FIND", aside: null, target: urlPath("log", "/1/1/2"), lineMarker: null,
            matcher: { dialect: "regex", raw: "/\"status\"/", pattern: "\"status\"", flags: "" }, body: null, position: { line: 1, column: 1 },
        };
        const r = await new Log().find(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
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

test("Log.read: a READ signal does not filter the addressed log resource", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/z", "v"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/1")), };
        const result = await readLog(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 200);
        assert.match(String(result.content), /^@[0-9A-Za-z]{5} 1:v$/, "{§edit-receipt-anchored-context} an EDIT row's body is its anchored landed context");
    } finally { db.close(); }
});

test("Log.find: body matcher selects the full projection before <L> projects text", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/data.json", '{"status":201,"entryId":7,"channel":"body"}'), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: readStmt(urlPath("worker", "/data.json")), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        // The matcher qualifies the complete JSON result. Because the target is
        // exact, <1> selects the first match location.
        const stmt: FindStatement = {
            metadata: null,
            op: "FIND", aside: null, target: urlPath("log", "/1/1/2"),
            lineMarker: { marks: [1, 1] },
            matcher: { dialect: "regex", raw: "/\\d+/", pattern: "\\d+", flags: "" }, body: null, position: { line: 1, column: 1 },
        };
        const r = await new Log().find(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 1);
        assert.equal(r.matchingPathCount, 1);
        assert.ok(r.matchLocationCount > 1);
        assert.equal(r.range?.unit, "matchLocation");
    } finally { db.close(); }
});

test("Log.find: a matcher FIND writes flat surgical coordinates", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await new Worker().edit(
            { ...editStmt("/notes", "alpha\nbeta\ngamma"), target: { kind: "url", raw: "worker:///notes", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/notes", query: null, fragment: null } },
            makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId }),
        );
        const result = await engine.dispatch({
            statement: {
                metadata: null,
                op: "FIND", aside: null,
                target: { kind: "url", raw: "worker:///notes", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/notes", query: null, fragment: null },
                lineMarker: null,
                matcher: { dialect: "regex", raw: "/\\w+/g", pattern: "\\w+", flags: "g" }, body: null,
                position: { line: 1, column: 1 },
            },
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.rowsWritten ?? 1, 1);
        const r = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        const locations = JSON.parse(r.content ?? "[]") as Array<{ region?: unknown }>;
        assert.equal(locations.length, 3);
        assert.ok(locations.every(({ region }) => region !== undefined));
    } finally { db.close(); }
});

test("Log.read: dispatches correctly via Engine.dispatch routing to log scheme", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/known-fact", "knowledge"),
            workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "model",
        });

        const result = await engine.dispatch({
            statement: readStmt(urlPath("log", "/1/1/1")),
            workspaceId, workerId, loopId, turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal((result as unknown as { mimetype: string }).mimetype, "text/plain");
        assert.match((result as unknown as { content: string }).content, /^@[0-9A-Za-z]{5} 1:knowledge$/, "{§edit-receipt-anchored-context}");
    } finally { db.close(); }
});

// {§log-channel-miss-names-stream} (#502) — a channel READ on a log execution item is a miss the
// receipt can resolve: the stream shares the coordinate and lives at <runtime>:///…/sh#channel.
test("Log.read: #channel on an execution log item names the command's stream address in its 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
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
                workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
                onDispatch: (id) => { logEntryId = id; settle(id); },
            }).then((result) => assert.equal(result.status, 200, "the command started"));
        });
        await dispatched;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        // Let the short command conclude so the stream carries its output.
        for (let i = 0; i < 100; i++) {
            const row = await db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId });
            if (row?.state === "resolved") break;
            await new Promise((r) => setTimeout(r, 50));
        }

        const address = await executionAddress(db, turnId);
        const miss = await readLog(
            readStmt({ ...urlPath("log", "/1/1/1/sh"), raw: "log:///1/1/1/sh#stdout", fragment: "stdout" }),
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        assert.equal(miss.status, 404);
        assert.equal(miss.problem?.type, "https://problems.plurnk.xyz/scheme/log/channel-not-found");
        assert.equal(miss.problem?.requestedChannel, "stdout");
        assert.equal(miss.problem?.stream, address, "the receipt carries the stream link the row already records");
        assert.equal(miss.problem?.recovery, `READ ${address}#stdout for the command's stdout stream.`);
        assert.ok(String(miss.problem?.detail).includes(`${address}#stdout`));

        // The named address is real: the same READ against it returns the output.
        const stream = await engine.look({
            statement: readStmt({ ...urlPath("sh", new URL(address).pathname), raw: `${address}#stdout`, fragment: "stdout" }),
            workspaceId, workerId, loopId, origin: "model",
        });
        assert.equal(stream.status, 200);
        assert.match(String((stream as { content?: unknown }).content), /hello/);
    } finally { db.close(); }
});

// {§log-range-miss-names-stream} — the range twin of the channel miss above: an empty-extent
// 416 on a log execution item names the recorded stream address, and that address reads.
test("Log.read: an empty-extent 416 on an execution log item names the command's stream address", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
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
                workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
                onDispatch: (id) => { logEntryId = id; settle(id); },
            }).then((result) => assert.equal(result.status, 200, "the command started"));
        });
        await dispatched;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        // Let the short command conclude so the stream carries its output.
        for (let i = 0; i < 100; i++) {
            const row = await db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId });
            if (row?.state === "resolved") break;
            await new Promise((r) => setTimeout(r, 50));
        }

        // The bodiless sibling shares the real execution's stream link, the way a drained or
        // bodiless call receipt does while its output stays readable at the stream address.
        const address = await executionAddress(db, turnId, 1);
        await insertExecutionRow(db, { workerId, loopId, turnId }, 2, { stream: address }, null);

        const miss = await readLog(
            { ...readStmt(urlPath("log", "/1/1/2/sh")), lineMarker: { marks: [2, 3] } },
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        assert.equal(miss.status, 416);
        assert.equal(miss.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.deepEqual(miss.problem?.range, { unit: "line", total: 0, requested: [2, 3] });
        assert.equal(miss.problem?.stream, address, "the receipt carries the stream link the row already records");
        assert.equal(miss.problem?.recovery, `READ ${address} for the command's stream.`);
        assert.equal(miss.problem?.detail, `Range 2,3 cannot select from empty content. The command's streams live at ${address}.`);
        assert.equal(miss.problem?.retryable, false);

        // The named address is real: the same READ against it returns the output.
        const stream = await engine.look({
            statement: readStmt({ ...urlPath("sh", new URL(address).pathname), raw: `${address}#stdout`, fragment: "stdout" }),
            workspaceId, workerId, loopId, origin: "model",
        });
        assert.equal(stream.status, 200);
        assert.match(String((stream as { content?: unknown }).content), /hello/);
    } finally { db.close(); }
});

// {§log-range-miss-names-stream} — no recorded stream, no naming: the generic slicer problem
// is byte-identical, the condition the augmentation must not disturb.
test("Log.read: an empty-extent 416 without a recorded stream keeps the generic slicer problem", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await insertExecutionRow(db, { workerId, loopId, turnId }, 1, {}, null);
        const miss = await readLog(
            { ...readStmt(urlPath("log", "/1/1/1/sh")), lineMarker: { marks: [2, 3] } },
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        assert.equal(miss.status, 416);
        assert.equal(miss.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.deepEqual(miss.problem?.range, { unit: "line", total: 0, requested: [2, 3] });
        assert.equal(Object.hasOwn(miss.problem ?? {}, "stream"), false);
        assert.equal(miss.problem?.recovery, "Choose a range within the available extent.");
        assert.equal(miss.problem?.detail, "Range 2,3 cannot select from empty content.");
        assert.equal(miss.problem?.retryable, false);
    } finally { db.close(); }
});

// {§log-range-miss-names-stream} — an ordinary out-of-range miss against a real extent keeps
// the generic problem even when the row records a stream.
test("Log.read: an out-of-range 416 against a command row's invocation names the stream (#759)", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await insertExecutionRow(db, { workerId, loopId, turnId }, 1, { stream: "sh:///0badcafe" }, "one\ntwo");
        const miss = await readLog(
            { ...readStmt(urlPath("log", "/1/1/1/sh")), lineMarker: { marks: [9] } },
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        assert.equal(miss.status, 416);
        assert.equal(miss.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.deepEqual(miss.problem?.range, { unit: "line", total: 2, requested: [9, 9] });
        assert.equal(miss.problem?.stream, "sh:///0badcafe");
        assert.equal(miss.problem?.recovery, "READ sh:///0badcafe for the command's stream.");
        assert.equal(miss.problem?.detail, "Line 9 is outside the available line range 1..2. The command's streams live at sh:///0badcafe.");
    } finally { db.close(); }
});
