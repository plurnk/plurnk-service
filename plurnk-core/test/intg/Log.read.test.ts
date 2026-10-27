import test, { describe, type TestContext } from "node:test";
import Workspace from "../../src/schemes/Workspace.ts";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import Daemon from "../../src/server/Daemon.ts";
import Envelope from "../../src/server/envelope.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import Fork from "../../src/core/fork.ts";
import LogEntry from "../../src/server/logEntry.ts";
import Turn from "../../src/core/Turn.ts";
import { type FindStatement, type ReadStatement, type UrlPath, type EditStatement, type TextLineMarker, type PlurnkOp, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement, type RepresentationPreparationRequest, type SchemeCtx, type SchemeHandler, type SchemeManifest } from "@plurnk/plurnk-schemes";
import { executionAddress, testExecutors, quiesceExecs } from "./_execs.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEnvelope, rootWorkspace, seedEntryWithChannel } from "./_db.ts";
import { makeSchemeCtx, readLog, DEFAULT_MIMETYPES, schemeManifest } from "./_scheme.ts";
import { matchLocations } from "./_find.ts";
import { clientRead } from "./_client-read.ts";
import { waitForDb, rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { type CatalogResource, type FindResult } from "../../src/schemes/_entry-find.ts";
import { urlPath, findStmt, killStmt, regex, editStmt, noteStmt, completeStmt, readStmt } from "./_dsl.ts";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Digest } from "@plurnk/plurnk-digest";
import { fixtureExecutors } from "./_mock.ts";
import { type Executor } from "@plurnk/plurnk-execs";
import { logEntries, packetSection } from "./_packet.ts";
import { serverProposals } from "./_approval.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyPatch, parsePatch, reversePatch } from "diff";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { type Db } from "../../src/core/Db.ts";

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
test("{§problems-schemes} Log.read: an empty-extent 416 without a recorded stream keeps the generic slicer problem", async () => {
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
        assert.equal(miss.problem?.recovery, "Choose a range within the available extent."); // {§problems-schemes}
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

describe("log-mutation-patch", () => {
// {§log-wire-format} — a settled file mutation's row keeps the unified diff of what it did, served
// as the row's `patch` channel; a byte write keeps none; a fork copies it; the diff reverses exactly.

















const execFileP = promisify(execFile);
type Row = { status_rx: number; rx: string; patch: string | null };
const ORIGINAL = "one\ntwo\nthree\n";
// A real PNG header: NUL-bearing bytes the mimetype registry classifies as binary.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const runtime = async (t: TestContext) => {
    serverProposals(t, "accept");
    const env = { PLURNK_SERVICE_GIT_ALLOWED: process.env.PLURNK_SERVICE_GIT_ALLOWED, PLURNK_SERVICE_GIT_AUTO: process.env.PLURNK_SERVICE_GIT_AUTO };
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const root = await mkdtemp(join(tmpdir(), "log-mutation-patch-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, "a.md"), ORIGINAL);
    await writeFile(join(root, "bin.png"), PNG);
    await git(["add", "a.md", "bin.png"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "seed"]);
    const db = await openMigrated();
    const ids = await seedEnvelope(db, `log-mutation-patch-${crypto.randomUUID()}`);
    await rootWorkspace(db, ids.workspaceId, root);
    const schemes = new SchemeRegistry();
    const executors = await testExecutors();
    schemes.registerRuntimeSchemes(executors);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(executors);
    // Git membership: the tracked files become members, as the first turn's pass makes them.
    await engine.warmWorkspaceDerivations(ids.workspaceId);
    t.after(async () => {
        await quiesceExecs(schemes);
        db.close();
        await rm(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    let sequence = 0;
    const row = (sessionId: number, seq: number) => db.log_read_by_coordinate.get<Row>({ session_id: sessionId, loop_seq: 1, turn_seq: 1, sequence: seq });
    const dispatch = async (source: string): Promise<Row & { sequence: number; content: string }> => {
        const { items } = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = items[0];
        if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement });
        const written = await row(ids.sessionId, sequence);
        assert.ok(written, source);
        const parsed = JSON.parse(written.rx) as { content?: unknown };
        return { ...written, sequence, content: typeof parsed.content === "string" ? parsed.content : "" };
    };
    return { db, ids, root, dispatch, row };
};

test("{§log-wire-format} every settled text mutation keeps its diff on its row; a byte write keeps none; the diff reverses exactly", async (t) => {
    const { db, ids, root, dispatch, row } = await runtime(t);

    // A READ materializes the member and its revision, as every real turn does before an EDIT.
    assert.equal((await dispatch("````READ (a.md) <1,-1>````")).status_rx, 200);
    const edited = await dispatch("````EDIT (a.md) <2>\nTWO\n````");
    assert.equal(edited.status_rx, 200, `the line edit lands: ${edited.rx.slice(0, 200)}`);
    assert.ok(edited.patch, "an EDIT of a text member keeps its patch");
    assert.match(edited.patch, /^Index: a\.md\n=+\n--- a\.md\tcurrent\n\+\+\+ a\.md\tproposed\n@@ -1,3 \+1,3 @@\n one\n-two\n\+TWO\n three\n$/u, "the patch is the unified diff, current to proposed");
    assert.equal(await readFile(join(root, "a.md"), "utf8"), "one\nTWO\nthree\n");
    // The diff is exact enough to undo: reverse-apply it to the written file and the original returns.
    const [hunk] = parsePatch(edited.patch);
    assert.equal(applyPatch("one\nTWO\nthree\n", reversePatch(hunk)), ORIGINAL, "reverse-applying the row's patch restores the original text");
    assert.doesNotMatch(edited.rx, /current\n\+\+\+/u, "the receipt carries no patch");

    const created = await dispatch("````EDIT (new.md)\nhello\n````");
    assert.ok(created.status_rx < 300, `create: ${created.rx.slice(0, 200)}`);
    assert.match(created.patch ?? "", /--- new\.md\tcurrent\n\+\+\+ new\.md\tproposed\n@@ -0,0 \+1,1 @@\n\+hello\n/u, "a creation's patch adds every line from nothing");

    const copied = await dispatch("````COPY (a.md) (copy.md)````");
    assert.ok(copied.status_rx < 300, `COPY: ${copied.rx.slice(0, 200)}`);
    assert.match(copied.patch ?? "", /\+\+\+ copy\.md\tproposed\n@@ -0,0 \+1,3 @@\n\+one\n\+TWO\n\+three\n$/u, "a COPY into a new file keeps the destination's patch");

    const moved = await dispatch("````MOVE (copy.md) (moved.md)````");
    assert.ok(moved.status_rx < 300, `MOVE: ${moved.rx.slice(0, 200)}`);
    const movedPatch = moved.patch ?? "";
    assert.match(movedPatch, /\+\+\+ moved\.md\tproposed\n@@ -0,0 \+1,3 @@\n\+one\n\+TWO\n\+three\n/u, "a MOVE keeps the destination write");
    assert.match(movedPatch, /--- copy\.md\tcurrent\n\+\+\+ copy\.md\tproposed\n@@ -1,3 \+0,0 @@\n-one\n-TWO\n-three\n$/u, "and the source removal, in application order");
    assert.ok(movedPatch.indexOf("moved.md\tproposed") < movedPatch.indexOf("copy.md\tcurrent"), "destination before source");

    const killed = await dispatch("````KILL (moved.md)````");
    assert.ok(killed.status_rx < 300, `KILL: ${killed.rx.slice(0, 200)}`);
    assert.match(killed.patch ?? "", /^Index: moved\.md\n=+\n--- moved\.md\tcurrent\n\+\+\+ moved\.md\tproposed\n@@ -1,3 \+0,0 @@\n-one\n-TWO\n-three\n$/u, "a KILL keeps every removed line");

    const bytes = await dispatch("````COPY (bin.png) (bin2.png)````");
    assert.ok(bytes.status_rx < 300, `binary COPY: ${bytes.rx.slice(0, 200)}`);
    assert.equal(bytes.patch, null, "a byte write keeps no patch");

    // The row serves its diff as the `patch` channel; a row without one has no such channel.
    const read = await dispatch(`\`\`\`\`READ (log:///1/1/${edited.sequence}/EDIT#patch) <1,-1>\`\`\`\``);
    assert.equal(read.status_rx, 200, `READ #patch: ${read.rx.slice(0, 200)}`);
    assert.match(read.content, /-two/u);
    assert.match(read.content, /\+TWO/u);
    const missing = await dispatch(`\`\`\`\`READ (log:///1/1/${bytes.sequence}/COPY#patch) <1,-1>\`\`\`\``);
    assert.equal(missing.status_rx, 404, `a patchless row has no patch channel: ${missing.rx.slice(0, 200)}`);

    // A fork copies the row with its patch.
    const branch = await Fork.fork(db, ids.sessionId, "branch");
    assert.equal((await row(branch, edited.sequence))?.patch, edited.patch, "the fork's copy of the EDIT row carries the same patch");
    assert.equal((await row(branch, bytes.sequence))?.patch, null, "and the patchless row stays patchless");
});
});

describe("log-readable-projection", () => {
const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `log-readable-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    let sequence = 0;
    const dispatch = async (source: string) => {
        const { items } = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        assert.equal(items.length, 1, source);
        const item = items[0];
        assert.equal(item?.kind, "statement", source);
        if (item?.kind !== "statement") throw new Error("test operation did not parse");
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement });
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence,
        });
        assert.ok(row);
        return JSON.parse(row.rx);
    };
    return { db, ids, dispatch, reserve: () => ++sequence };
};

test("{§log-kill-scope}: READ and COPY omit deliberate trims in original coordinates", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    assert.equal((await dispatch("````EDIT (workspace:///source.txt)\none\ntwo\nsecret\nfour\nfive\n````")).status, 201);
    assert.equal((await dispatch("````READ (workspace:///source.txt) <1,-1>````")).status, 200);
    const target = "log:///1/1/2/READ";
    assert.equal((await dispatch(`\`\`\`\`KILL (${target}) <3>\`\`\`\``)).status, 200);
    const read = await dispatch(`\`\`\`\`READ (${target}) <2,4>\`\`\`\``);
    assert.equal(read.status, 200);
    assert.equal(read.content, "two\nfour");
    assert.deepEqual(read.lineOrdinals, [2, 4]);
    assert.equal((await dispatch(`\`\`\`\`COPY (log:///1/1/2) <${read.lineAnchors[1]}> (workspace:///anchored.txt)\`\`\`\``)).status, 201);
    assert.equal((await dispatch("````READ (workspace:///anchored.txt) <1,-1>````")).content, "four", "canonical leaf aliases share anchor identity");
    assert.equal((await dispatch(`\`\`\`\`COPY (${target}) <2,4> (workspace:///copy.txt)\`\`\`\``)).status, 201);
    assert.equal((await dispatch("````READ (workspace:///copy.txt) <1,-1>````")).content, "two\nfour");
    assert.equal((await dispatch(`\`\`\`\`FIND (${target}) /secret/\`\`\`\``)).status, 204);
    const found = await dispatch(`\`\`\`\`FIND (${target}) /four/\`\`\`\``);
    assert.equal(found.status, 200);
    assert.match(JSON.parse(found.content)[0].region, /^<4,/u);
    assert.equal((await dispatch(`\`\`\`\`READ (${target}) <3>\`\`\`\``)).status, 204);
    assert.equal((await dispatch(`\`\`\`\`COPY (${target}) (log:///1/1/2/READ)\`\`\`\``)).status, 400, "the log is never a write target");
    // {§move}: MOVE from a log region is the COPY above plus the same scoped KILL —
    // the destination receives the readable lines, the projection trims them, the evidence stays.
    const moved = await dispatch(`\`\`\`\`MOVE (${target}) <2,4> (workspace:///moved.txt)\`\`\`\``);
    assert.equal(moved.status, 201, JSON.stringify(moved));
    assert.deepEqual(
        (moved.effects as Array<{ target: string; action: string }>).map(({ target: effectTarget, action }) => `${action} ${effectTarget}`),
        ["create workspace:///moved.txt", `update ${target}`],
    );
    assert.equal((await dispatch("````READ (workspace:///moved.txt) <1,-1>````")).content, "two\nfour", "the destination holds exactly the readable region");
    assert.equal((await dispatch(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``)).content, "one\nfive", "the moved lines left the readable projection");
    const whole = await dispatch(`\`\`\`\`MOVE (${target}) (workspace:///rest.txt)\`\`\`\``);
    assert.equal(whole.status, 201, JSON.stringify(whole));
    assert.deepEqual(
        (whole.effects as Array<{ target: string; action: string }>).map(({ target: effectTarget, action }) => `${action} ${effectTarget}`),
        ["create workspace:///rest.txt", `delete ${target}`],
        "an unscoped MOVE retires the row exactly as an unscoped KILL does",
    );
    assert.equal((await dispatch("````READ (workspace:///rest.txt) <1,-1>````")).content, "one\nfive");
    const original = (await db.test_log_entries_by_loop.all<{ sequence: number; rx: string; active: number }>({ loop_id: ids.loopId }))
        .find((row) => row.sequence === 2);
    assert.ok(original, "the recorded row is still there");
    assert.equal(original.active, 0, "retired from the active projection");
    assert.equal(JSON.parse(original.rx).content, "one\ntwo\nsecret\nfour\nfive", "curation never rewrites recorded evidence");
});

test("{§log-wire-format}: a stored source slice and its curated log resource retain their own extents", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, pathname: "/source.txt", content, mimetype: "text/plain" });
    const original = await dispatch("````READ (workspace:///source.txt) <17,18>````");
    assert.equal(original.content, "line 17\nline 18");
    assert.equal((await dispatch("````KILL (log:///1/1/1/READ) <1>````")).status, 200);
    const reread = await dispatch("````READ (log:///1/1/1/READ) <1,-1>````");
    assert.equal(reread.content, "line 18");
    assert.deepEqual(reread.range, { unit: "line", total: 2, requested: [1, -1], returned: [2, 2] });
    const recorded = await db.log_read_by_coordinate.get<{ rx: string; folded: string; status_rx: number }>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1 });
    assert.ok(recorded);
    assert.deepEqual(JSON.parse(recorded.rx), original, "curation did not modify the recorded acquisition");
    const [row] = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/1/1", op: "READ", status: recorded.status_rx,
        target: { scheme: "workspace", pathname: "/source.txt" }, rx: JSON.parse(recorded.rx), folded: recorded.folded,
    }], contentWeight));
    assert.equal(row?.range, "<17,18> of 30 lines");
    assert.deepEqual(row?.trimmed, ["<1>"]);
    assert.equal(row?.body, "18:line 18\n");
    assert.equal((await dispatch("````READ (workspace:///source.txt) <1,-1>````")).content, content, "the source still has every line");
});

test("{§log-kill-scope}: a multiline pattern never copies a curated gap", async (t) => {
    const { dispatch } = await runtime(t);
    await dispatch("````EDIT (workspace:///source.txt)\nalpha\nsecret\nomega\n````");
    await dispatch("````READ (workspace:///source.txt) <1,-1>````");
    const target = "log:///1/1/2/READ";
    await dispatch(`\`\`\`\`KILL (${target}) <2>\`\`\`\``);
    const pattern = "/alpha\\nomega/";
    const found = await dispatch(`\`\`\`\`FIND (${target}) ${pattern}\`\`\`\``);
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.deepEqual(JSON.parse(found.content).map(({ region }: { region: unknown }) => region), [
        "<1,1,2,1>",
        "<3,1,3,6>",
    ]);
    const read = await dispatch(`\`\`\`\`READ (${target}) <1,-1> ${pattern}\`\`\`\``);
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.equal(read.content, "alpha\nomega");
    const copied = await dispatch(`\`\`\`\`COPY (${target}) <1,3> (workspace:///copy.txt)\`\`\`\``);
    assert.equal(copied.status, 201, JSON.stringify(copied));
    assert.equal((await dispatch("````READ (workspace:///copy.txt) <1,-1>````")).content, "alpha\nomega");
});

test("{§log-kill-scope}: FIND prices retained bodies consistently in rows and folders", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    const content = "apple\nsecret\npear";
    await dispatch(`\`\`\`\`EDIT (workspace:///source.txt)
${content}
\`\`\`\``);
    await dispatch("````READ (workspace:///source.txt) <1,-1>````");
    const log = new Log();
    const ctx = makeSchemeCtx({ db, ...ids, mimetypes: DEFAULT_MIMETYPES });
    const weigh = ctx.weigh ?? contentWeight;
    const folderWeight = async () => {
        const result = await log.find(findStmt(urlPath("log", "/*")), ctx);
        assert.equal(result.status, 200);
        const folder = result.results.find((item) => Array.isArray(item) && item[0].path === "log:///1/**");
        assert.ok(Array.isArray(folder) && "items" in folder[0]);
        return folder[0].weight;
    };
    const before = await folderWeight();
    assert.equal((await dispatch("````KILL (log:///1/1/2/READ) <2>````")).status, 200);
    const result = await log.find(findStmt(urlPath("log", "/1/1/2/READ")), ctx);
    assert.equal(result.status, 200);
    const item = result.results[0];
    assert.ok(Array.isArray(item));
    assert.ok("lines" in item[0]);
    assert.equal(item[0].lines, 3, "scope planning still uses the original physical line domain");
    assert.equal(item[0].weight, weigh("apple\npear"));
    assert.equal(await folderWeight(), before - weigh(content) + item[0].weight, "folder weight excludes the trimmed line too");
});

test("{§log-kill-scope}: a byte-view receipt is readable text, not a second binary resource", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    await seedEntryWithChannel(db, {
        workspaceId: ids.workspaceId, pathname: "/data.bin",
        content: Buffer.from([0, 1, 2, 3]).toString("base64"), mimetype: "application/octet-stream",
    });
    const sourceRead = await dispatch("````READ (workspace:///data.bin) <1,-1>````");
    assert.equal(sourceRead.status, 200);
    assert.equal(sourceRead.projection, "hex");
    assert.equal(sourceRead.mimetype, "application/octet-stream");
    const target = "log:///1/1/1/READ";
    const complete = await dispatch(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``);
    assert.equal(complete.status, 200, JSON.stringify(complete));
    assert.equal(complete.content, sourceRead.content);
    assert.equal((await dispatch(`\`\`\`\`KILL (${target}) <2>\`\`\`\``)).status, 200);
    const found = await dispatch(`\`\`\`\`FIND (${target}) /02/\`\`\`\``);
    assert.equal(found.status, 200);
    assert.match(JSON.parse(found.content)[0].region, /^<3,/u);
    await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes: DEFAULT_MIMETYPES }));
    assert.equal((await dispatch(`\`\`\`\`FIND (${target}) ~02\`\`\`\``)).status, 200, "hex receipt text participates in FTS");
    assert.equal((await dispatch(`\`\`\`\`FIND (${target}) ~01\`\`\`\``)).status, 204, "FTS omits the trimmed byte-view line");
    assert.equal((await dispatch(`\`\`\`\`COPY (${target}) (workspace:///hex.txt)\`\`\`\``)).status, 201);
    const copied = await dispatch("````READ (workspace:///hex.txt) <1,-1>````");
    assert.equal(copied.content, "00\n02\n03");
    const repeatedSource = await dispatch("````READ (workspace:///data.bin) <1,-1>````");
    assert.equal(repeatedSource.content, sourceRead.content, "the binary source still contains every original byte");
    const original = await db.log_read_by_coordinate.get<{ rx: string }>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1 });
    assert.deepEqual(JSON.parse(original!.rx), sourceRead, "the source mimetype and original byte receipt remain intact in forensic history");
});

test("{§log-kill-scope}: initially suppressed program READ receipts remain readable until explicitly trimmed, and forks preserve both facts", async (t) => {
    const { db, ids, dispatch, reserve } = await runtime(t);
    const content = "````NOTE\ncontinue\n````";
    const sequence = reserve();
    await db.engine_insert_log_entry.get({
        session_id: ids.sessionId, loop_id: ids.loopId, turn_id: ids.turnId, sequence,
        origin: "model", source: null, model_call_id: null, op: "READ",
        scheme: null, username: null, password: null, hostname: null, port: null,
        pathname: null, query: null, fragment: null, lineMarker: null,
        tx: "", mimetype_tx: "text/vnd.plurnk", rx: JSON.stringify({ content, mimetype: "text/vnd.plurnk" }),
        mimetype_rx: "application/json", status_rx: 200, weight: contentWeight(content),
        state: "resolved", outcome: null, attrs: "{}", initial_folded: "[[1,-1]]",
    });
    const target = "log:///1/1/1/READ";
    assert.equal((await dispatch(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``)).content, content);
    await t.test("{§log-kill-scope} COPY of a textual program into plain text remains verbatim", async () => {
        const copied = await dispatch(`\`\`\`\`COPY (${target}) (workspace:///program.txt)\`\`\`\``);
        assert.equal(copied.status, 201, JSON.stringify(copied));
    });
    assert.equal((await dispatch(`\`\`\`\`KILL (${target}) <2>\`\`\`\``)).status, 200);
    const branch = await Fork.fork(db, ids.sessionId, "branch");
    const forkRead = await readLog({ ...readStmt(urlPath("log", "/1/1/1/READ")), lineMarker: { marks: [1, -1] } }, makeSchemeCtx({ db, workspaceId: ids.workspaceId, sessionId: branch }));
    assert.equal(forkRead.content, "````NOTE\n````");
    const forkRows = await db.test_fork_log_entries.all<{ initial_folded: string; projection_folded: string }>({ session_id: branch });
    assert.equal(forkRows[0]?.initial_folded, "[[1,-1]]");
    assert.equal(forkRows[0]?.projection_folded, "[[2,2]]");
    assert.equal((await dispatch(`\`\`\`\`KILL (${target}) <1,-1>\`\`\`\``)).status, 200);
    assert.equal((await dispatch(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``)).status, 204);
    const stillReadable = await readLog({ ...readStmt(urlPath("log", "/1/1/1/READ")), lineMarker: { marks: [1, -1] } }, makeSchemeCtx({ db, workspaceId: ids.workspaceId, sessionId: branch }));
    assert.equal(stillReadable.content, forkRead.content, "parent curation does not change the branch's projection");
    const original = await db.log_read_by_coordinate.get<{ rx: string }>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence });
    assert.equal(JSON.parse(original!.rx).content, content);
    assert.equal((await dispatch(`\`\`\`\`KILL (${target})\`\`\`\``)).status, 200);
    assert.equal((await dispatch(`\`\`\`\`READ (${target})\`\`\`\``)).status, 404);
    assert.equal((await dispatch(`\`\`\`\`COPY (${target}) (workspace:///retired.txt)\`\`\`\``)).status, 404);
});

test("{§log-kill-scope}: trimming invalidates search and a racing derivation cannot reattach old content", { timeout: 10_000 }, async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    await dispatch("````EDIT (workspace:///source.txt)\napple\nsecret\npear\n````");
    await dispatch("````READ (workspace:///source.txt) <1,-1>````");
    await dispatch("````KILL (workspace:///source.txt)````");
    const ctx = makeSchemeCtx({ db, ...ids, mimetypes: DEFAULT_MIMETYPES });
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const process = DEFAULT_MIMETYPES.process.bind(DEFAULT_MIMETYPES);
    t.mock.method(DEFAULT_MIMETYPES, "process", async (...args: Parameters<typeof process>) => {
        if (args[0].path === "1/1/2/READ") {
            started.resolve();
            await resume.promise;
        }
        return process(...args);
    });
    const inFlight = SearchIndex.maintain(ctx);
    try {
        await started.promise;
        assert.equal((await dispatch("````KILL (log:///1/1/2/READ) <2>````")).status, 200);
    } finally { resume.resolve(); }
    await inFlight;
    const candidates = await db.log_find_candidates.all<{ coordinate: string; deep_hash: string | null }>({ session_id: ids.sessionId, scope_prefix: null, max_id: null });
    assert.equal(candidates.find((row) => row.coordinate === "1/1/2")?.deep_hash, null, "stale in-flight derivation was not attached");
    await SearchIndex.maintain(ctx);
    assert.equal((await dispatch("````FIND (log:///1/1/2/READ) ~secret````")).status, 204);
    const retained = await dispatch("````FIND (log:///1/1/2/READ) ~pear````");
    assert.equal(retained.status, 200);
    assert.match(JSON.parse(retained.content)[0].region, /^<3,/u);
    assert.equal((await dispatch("````KILL (log:///1/1/2/READ) <3>````")).status, 200);
    await SearchIndex.maintain(ctx);
    assert.equal((await dispatch("````FIND (log:///1/1/2/READ) ~pear````")).status, 204, "later curation also invalidates an already attached artifact");
    const read = await dispatch("````READ (log:///1/1/2/READ) <1,-1>````");
    const wire = PacketWire.renderLog([{ coordinate: "1/1/99", op: "READ", origin: "model", status: read.status, rx: read, lineAnchors: read.lineAnchors, lineNumberWidth: read.lineNumberWidth }], contentWeight);
    assert.match(wire, /1(?:<@[0-9A-Za-z]{5}>|:)apple/);
    assert.doesNotMatch(wire, /secret|pear/);
});

// {§log-kill-scope} — the recorded emission replayed through the parser and the engine.
test("{§log-kill-scope} {§range-starts-at-one}: `KILL (log:///…/READ) <0, -1>` is refused 416 with the forms a log body takes, which then work", async (t) => {
    const { dispatch } = await runtime(t);
    await dispatch("````EDIT (workspace:///source.txt)\none\ntwo\n````");
    await dispatch("````READ (workspace:///source.txt) <1,-1>````");
    const refused = await dispatch("````KILL (log:///1/1/2/READ) <0, -1>````");
    assert.equal(refused.status, 416);
    assert.match(refused.problem.type, /\/range-not-satisfiable$/);
    assert.equal(refused.problem.detail, "Range <0,-1> starts at 0, which is not a line; lines are numbered from 1."); // {§operation-results}
    assert.equal(refused.problem.recovery, "Trim one line with <L> or lines L through M with <L,M>; KILL (log:///1/1/2/READ) with no scope retires the whole row."); // {§operation-results}
    assert.equal((await dispatch("````KILL (log:///1/1/2/READ) <1,-1>````")).status, 200);
    assert.equal((await dispatch("````KILL (log:///1/1/2/READ)````")).status, 200);
});
});

describe("log_entries", () => {
type SqlValue = string | number | bigint | null;

const minimalLog = async (db: Db, ctx: { sessionId: number; loopId: number; turnId: number }, overrides: Record<string, SqlValue> = {}): Promise<number> => {
    const params: Record<string, SqlValue> = {
        session_id: ctx.sessionId, loop_id: ctx.loopId, turn_id: ctx.turnId,
        sequence: 1, origin: "model", op: "EDIT",
        source: null,
        signal: null,
        scheme: "workspace", pathname: "/meaning", port: null, query: null,
        lineMarker: null,
        tx: "````EDIT (workspace:///meaning)\n42\n````", mimetype_tx: "text/x-plurnk",
        rx: "", mimetype_rx: "text/plain", status_rx: 201,
        weight: 32, attrs: "{}",
        ...overrides,
    };
    const row = await db.test_log_entries_insert_full.get<{ id: number }>(params);
    if (row === undefined) throw new Error("log_entries insert returned no row");
    return row.id;
};

test("{§methods-invocation} fetchLogEntry surfaces loop_seq/turn_seq (ordinals), not just DB ids", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 3);   // loop ordinal 3
        const turnId = await insertTurn(db, loopId, 2);  // turn ordinal 2
        const id = await minimalLog(db, { sessionId, loopId, turnId }, { tx: JSON.stringify("in"), rx: JSON.stringify("out") });
        const wire = await LogEntry.fetchLogEntry(db, id);
        assert.equal(wire.loop_seq, 3, "loop ordinal on the wire");
        assert.equal(wire.turn_seq, 2, "turn ordinal on the wire");
        assert.equal(wire.loop_id, loopId, "DB loop id still present");
        assert.equal(wire.turn_id, turnId, "DB turn id still present");
    } finally { await db.close(); }
});

test("{§methods-invocation} fetchLogEntry preserves causal source and structured attributes", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, `wire-provenance-${crypto.randomUUID()}`);
        const id = await minimalLog(db, ctx, {
            origin: "_plurnk",
            source: "session://researcher",
            attrs: JSON.stringify({ kind: "entry_materialized" }),
            tx: JSON.stringify("in"),
            rx: JSON.stringify("out"),
        });
        const wire = await LogEntry.fetchLogEntry(db, id);
        assert.equal(wire.source, "session://researcher");
        assert.deepEqual(wire.attrs, { kind: "entry_materialized" });
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: sequence UNIQUE within turn", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionuniq");
        await minimalLog(db, ctx, { sequence: 1 });
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 1 }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: sequence >= 1 enforced", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionneg");
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 0 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: origin enum", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-origin");
        for (const origin of ["model", "client", "_plurnk"] as const) {
            const turnId = origin === "model"
                ? ctx.turnId
                : (await Turn.open(db, { loopId: ctx.loopId, producer: origin, kind: "operation" })).id;
            await minimalLog(db, { ...ctx, turnId }, { origin });
        }
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 2, origin: "admin" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: session, loop, turn, producer, and model-call ownership are one chain", async () => {
    const db = await openMigrated();
    try {
        const first = await seedEnvelope(db, `ws-log-owner-a-${crypto.randomUUID()}`);
        const secondSession = await insertSession(db, first.workspaceId);
        const secondLoop = await insertLoop(db, secondSession, 1);
        const secondTurn = await Turn.open(db, { loopId: secondLoop, producer: "client", kind: "operation" });

        await assert.rejects(
            () => minimalLog(db, { ...first, turnId: secondTurn.id }),
            /log entry must match its turn ownership and producer/,
        );
        await assert.rejects(
            () => minimalLog(db, first, { origin: "client" }),
            /log entry must match its turn ownership and producer/,
        );

        const modelCall = await db.engine_open_model_call.get<{ id: number }>({
            turn_id: first.turnId,
            kind: "emission",
            attributions: "[]",
            model: "mock/model",
        });
        assert.ok(modelCall !== undefined);
        await assert.rejects(
            () => db.engine_insert_log_entry.get({
                session_id: secondSession, loop_id: secondLoop, turn_id: secondTurn.id,
                sequence: 1, origin: "client", source: null, model_call_id: modelCall.id,
                op: "READ",
                scheme: "workspace", username: null, password: null, hostname: null, port: null,
                pathname: "/wrong-call", query: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/plain", rx: "", mimetype_rx: "text/plain",
                status_rx: 200, weight: 0, state: "resolved", outcome: null, attrs: "{}",
            }),
            /log entry model call does not match its represented result/,
        );
    } finally { await db.close(); }
});

test("{§turn-source-resources}: only rejected model attempts use actionless log rows", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionless-kinds");
        await minimalLog(db, ctx, {
            sequence: 1, origin: "model", op: null, attrs: JSON.stringify({ kind: "emissionAttempt" }),
        });
        for (const [sequence, origin, kind] of [
            [2, "model", "turnOps"],
            [3, "_plurnk", "turnOps"],
            [4, "_plurnk", "emissionAttempt"],
            [5, "model", "modelOutput"],
            [6, "model", "initialization"],
            [7, "model", "overflow"],
        ] as const) {
            await assert.rejects(
                () => minimalLog(db, ctx, { sequence, origin, op: null, attrs: JSON.stringify({ kind }) }),
                /(?:CHECK constraint failed|actionless log entry does not match its turn producer)/,
            );
        }
    } finally { await db.close(); }
});

// (No "op enum" test: log_entries.op does not CHECK-enumerate the grammar op set. Op validity lives at the parse
// (grammar) + type (PlurnkOp) layer; the column stores what the typed engine writes.)

test("{§db-migrations} log_entries: status_rx range 100..599", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-statusrx");
        for (const [i, s] of [100, 200, 499, 599].entries()) {
            await minimalLog(db, ctx, { sequence: i + 1, status_rx: s });
        }
        for (const bad of [99, 600, 0, -1]) {
            await assert.rejects(
                () => minimalLog(db, ctx, { sequence: 999, status_rx: bad }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: mimetype CHECK", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-mimetypes");
        await assert.rejects(() => minimalLog(db, ctx, { mimetype_tx: "" }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { mimetype_rx: "" }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: scheme nullable; non-empty CHECK", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tscheme");
        await minimalLog(db, ctx, { sequence: 1, scheme: null });
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 2, scheme: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: port range", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tport");
        await minimalLog(db, ctx, { sequence: 1, port: 443 });
        await minimalLog(db, ctx, { sequence: 2, port: 0 });
        await minimalLog(db, ctx, { sequence: 3, port: 65535 });
        await minimalLog(db, ctx, { sequence: 4, port: null });
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 5, port: 65536 }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 6, port: -1 }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("{§scheme-address} log_entries: serialized query preserves absence, empty, order, and duplicates", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-json");
        await minimalLog(db, ctx, { sequence: 1, query: null, lineMarker: null });
        await minimalLog(db, ctx, { sequence: 2, query: "", signal: '["+a","+b"]', lineMarker: '{"first":1,"last":10}' });
        await minimalLog(db, ctx, { sequence: 3, query: "b=2&a=1&a=3" });
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 4, signal: "{bad" }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 5, lineMarker: "broken" }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: a malformed bound curation plan rolls back its row and every target change", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-curation-atomicity");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        for (const plan of [
            {
                targets: [{
                    id: targetId,
                    activeBefore: 1,
                    activeAfter: 1,
                    foldedBefore: [],
                    foldedAfter: [[0, -1]],
                }],
            },
            {
                targets: [{
                    id: targetId,
                    activeBefore: 1,
                    activeAfter: 1,
                    foldedBefore: [],
                    foldedAfter: [[5, 2]],
                }],
            },
        ]) {
            await assert.rejects(
                () => minimalLog(db, ctx, {
                    sequence: 2,
                    op: "KILL",
                    scheme: "log",
                    attrs: JSON.stringify({ __plurnk_curation: plan }),
                }),
                /invalid private log curation payload/,
            );
        }
        assert.equal(
            (await db.test_get_log_folded.get<{ folded: string }>({
                session_id: ctx.sessionId,
                loop_seq: 1,
                turn_seq: 1,
                sequence: 1,
            }))?.folded,
            "[]",
        );
        assert.equal(
            (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: ctx.turnId }))?.n,
            1,
            "the failed outer INSERT leaves no curation event row",
        );
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: folded body intervals are canonical and curation snapshots reject collisions", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-folded-intervals");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        await assert.rejects(
            () => db.log_set_folded_by_id.run({ id: targetId, folded: "[[1,2],[3,4]]" }),
            /folded ranges are invalid/,
            "adjacent intervals must be merged by the visibility owner",
        );
        await db.log_set_folded_by_id.run({ id: targetId, folded: "[[2,3]]" });
        await assert.rejects(
            () => minimalLog(db, ctx, {
                sequence: 2,
                op: "KILL",
                scheme: "log",
                attrs: JSON.stringify({
                    __plurnk_curation: {
                        targets: [{
                            id: targetId,
                            activeBefore: 1,
                            activeAfter: 1,
                            foldedBefore: [],
                            foldedAfter: [],
                        }],
                        add: [],
                        remove: [],
                    },
                }),
            }),
            /invalid private log curation payload/,
            "a stale before snapshot rejects the complete event",
        );
        assert.equal(
            (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: ctx.turnId }))?.n,
            1,
        );
    } finally { await db.close(); }
});

test("{§log-history-projection}: every event receives one projection and inactive is terminal", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-projection-lifecycle");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        assert.deepEqual(
            await db.test_get_log_projection.get({
                session_id: ctx.sessionId,
                loop_seq: 1,
                turn_seq: 1,
                sequence: 1,
            }),
            { id: targetId, active: 1, folded: "[]" },
            "the event and its initial active projection land together",
        );
        await assert.rejects(
            () => db.test_log_entry_projection_delete.run({ id: targetId }),
            /durable log event must retain its projection/,
            "the one-to-one current state cannot be detached from its evidence",
        );
        const plan = (targets: Array<{ id: number; activeBefore: 0 | 1; activeAfter: 0 | 1 }>): { targets: string } =>
            ({ targets: JSON.stringify(targets.map((t) => ({ ...t, foldedBefore: "[]", foldedAfter: "[]" }))) });
        assert.deepEqual(await db.log_apply_projection_plan.all(plan([{ id: targetId, activeBefore: 1, activeAfter: 0 }])), [{ id: targetId }]);
        await assert.rejects(
            () => db.log_apply_projection_plan.all(plan([{ id: targetId, activeBefore: 0, activeAfter: 1 }])),
            /killed log entry cannot re-enter the active projection/,
        );
        // {§log-history-projection} — a plan with one stale precondition lands nothing, including its
        // still-valid targets: the second row here is live, and stays live.
        const liveId = await minimalLog(db, ctx, { sequence: 2 });
        assert.deepEqual(await db.log_apply_projection_plan.all(plan([
            { id: liveId, activeBefore: 1, activeAfter: 0 },
            { id: targetId, activeBefore: 1, activeAfter: 0 },
        ])), [], "one stale target (already retired) withholds the whole plan");
        assert.equal((await db.test_get_log_projection.get<{ active: number }>({ session_id: ctx.sessionId, loop_seq: 1, turn_seq: 1, sequence: 2 }))?.active, 1, "the valid target was not touched");
        assert.deepEqual(await db.log_apply_projection_plan.all(plan([{ id: liveId, activeBefore: 1, activeAfter: 0 }])), [{ id: liveId }], "alone, the valid target lands");
        assert.equal(
            (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: ctx.turnId }))?.n,
            2,
            "projection retirement never deletes its durable event",
        );
    } finally { await db.close(); }
});

test("{§log-history-projection}: curation effects are immutable while their events survive", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-curation-effect-history");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        const operationId = await minimalLog(db, ctx, { sequence: 2, op: "KILL", scheme: "log" });
        await db.test_insert_log_curation_effect.run({
            operation_log_entry_id: operationId,
            target_log_entry_id: targetId,
            active_before: 1,
            active_after: 1,
            folded_before: "[]",
            folded_after: "[]",
        });
        await assert.rejects(
            () => db.test_log_curation_effect_update.run({
                operation_log_entry_id: operationId,
                target_log_entry_id: targetId,
                folded_after: "[]",
            }),
            /log curation effects are immutable execution evidence/,
        );
        await assert.rejects(
            () => db.test_log_curation_effect_delete.run({
                operation_log_entry_id: operationId,
                target_log_entry_id: targetId,
            }),
            /log curation effects can only be removed with their containing history/,
        );
        assert.equal(
            (await db.test_log_curation_effects_by_session.all({ session_id: ctx.sessionId })).length,
            1,
            "rejected mutation leaves the exact effect intact",
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: session_id NOT NULL", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-norun");
        await assert.rejects(
            () => db.test_log_entries_insert_no_session_id.run({ loop_id: ctx.loopId, turn_id: ctx.turnId }),
            /NOT NULL constraint failed: log_entries\.session_id/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: each FK rejection path", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fkpaths");
        await assert.rejects(() => minimalLog(db, ctx, { session_id: 99999 }),  /FOREIGN KEY constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { loop_id: 99999 }), /FOREIGN KEY constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { turn_id: 99999 }), /FOREIGN KEY constraint failed/);
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: ON DELETE CASCADE via turn", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-turncasc");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        const operationId = await minimalLog(db, ctx, { sequence: 2, op: "KILL", scheme: "log" });
        await db.test_insert_log_curation_effect.run({
            operation_log_entry_id: operationId,
            target_log_entry_id: targetId,
            active_before: 1,
            active_after: 1,
            folded_before: "[]",
            folded_after: "[]",
        });
        await db.test_log_entries_delete_turns.run({ id: ctx.turnId });
        const remaining = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
        assert.deepEqual(
            await db.test_log_curation_effects_by_session.all({ session_id: ctx.sessionId }),
            [],
            "containing-history teardown still cascades immutable effects",
        );
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: full CASCADE chain", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fullchain");
        await minimalLog(db, ctx);
        await db.test_workspaces_delete.run({ id: ctx.workspaceId });
        const remaining = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§turn-source-resources}: the schema admits an emission row only as one born-folded _plurnk announcement of its own turn's admitted ops source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `emission-row-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const content = "```READ (a.md)\n```";
        const emission = async (overrides: Record<string, SqlValue> = {}): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                session_id: sessionId, loop_id: loopId, turn_id: turn.id, sequence: 1,
                origin: "_plurnk", source: null, model_call_id: null, op: "READ", signal: null,
                scheme: "ops", username: null, password: null, hostname: "alice", port: null,
                pathname: `/1/${turn.sequence}`, query: null, fragment: null, lineMarker: null,
                tx: "{}", mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200, content, mimetype: "text/vnd.plurnk" }), mimetype_rx: "application/json", status_rx: 200,
                weight: 8, state: "resolved", outcome: null, attrs: JSON.stringify({ kind: "emission" }), initial_folded: "[[1,-1]]",
                ...overrides,
            });
            if (row === undefined) throw new Error("emission insert returned no row");
            return row.id;
        };
        const refused = /an emission row is one born-folded _plurnk announcement of its own turn's admitted ops source/;
        await assert.rejects(() => emission(), refused, "a turn without an admitted ops source announces nothing");
        await Turn.recordSource(db, turn.id, "ops", content);
        const shapes: Array<[Record<string, SqlValue>, string]> = [
            [{ origin: "model" }, "only the harness writes the announcement"],
            [{ op: "FIND" }, "the announcement is a READ"],
            [{ scheme: "reasoning" }, "of the ops source"],
            [{ initial_folded: "[]" }, "born folded: the emission rides outside its record"],
            [{ rx: JSON.stringify({ status: 200, content: "", mimetype: "text/vnd.plurnk" }) }, "an admitted emission is never empty"],
            [{ pathname: `/1/${turn.sequence + 1}` }, "of its own turn"],
            [{ hostname: "bob" }, "a row the session wrote names the session"],
        ];
        for (const [overrides, reason] of shapes) await assert.rejects(() => emission(overrides), refused, reason);
        await minimalLog(db, { sessionId, loopId, turnId: turn.id }, { sequence: 5 });
        await assert.rejects(() => emission({ sequence: 3 }), refused, "written before the turn's operations, so never behind one");
        const id = await emission({ sequence: 6 });
        await assert.rejects(() => emission({ sequence: 7 }), /UNIQUE constraint failed: log_entries\.turn_id/, "one announcement per turn");
        await assert.rejects(() => db.test_log_entries_update_rx.run({ id, rx: JSON.stringify({ status: 200, content: "rewritten", mimetype: "text/vnd.plurnk" }) }), /an emission row is frozen/);
        await assert.rejects(() => db.test_log_entries_update_weight.run({ id, weight: 1 }), /an emission row is frozen/);
        const plan = (foldedAfter: string, activeAfter: 0 | 1) => ({ targets: JSON.stringify([{ id, activeBefore: 1, activeAfter, foldedBefore: "[]", foldedAfter }]) });
        await assert.rejects(() => db.log_apply_projection_plan.all(plan("[[1,1]]", 1)), /an emission row is curated whole/);
        await Turn.complete(db, turn.id, 200);
        const operation = await Turn.open(db, { loopId, producer: "_plurnk", kind: "operation" });
        await Turn.recordSource(db, operation.id, "ops", content);
        await assert.rejects(() => emission({ turn_id: operation.id, pathname: `/1/${operation.sequence}` }), refused, "a programmatic turn does not admit an emission");
        await Turn.complete(db, operation.id, 200);
        const branch = await Fork.fork(db, sessionId, "branch");
        assert.deepEqual(
            (await db.test_emission_rows_by_session.all<{ coordinate: string; hostname: string; pathname: string }>({ session_id: branch }))
                .map(({ coordinate, hostname, pathname }) => ({ coordinate, hostname, pathname })),
            [{ coordinate: `1/${turn.sequence}/6`, hostname: "alice", pathname: `/1/${turn.sequence}` }],
            "a fork's inherited copy keeps naming the session that wrote it",
        );
        assert.deepEqual(await db.log_apply_projection_plan.all(plan("[]", 0)), [{ id }], "a whole KILL retires it");
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: immutability trigger — UPDATE of core fields rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-immut");
        const id = await minimalLog(db, ctx);
        // Lifecycle columns (state/outcome/status_rx/rx) are updateable for
        // the proposal lifecycle, and the curation trigger may remove its
        // private attrs payload; the original action stays pinned forever.
        await assert.rejects(
            () => db.test_log_entries_update_tx.run({ tx: "tampered", id }),
            /log_entries core fields are immutable/,
        );
        const tx = (await db.test_log_entries_get_tx_by_id.get<{ tx: string }>({ id }))?.tx;
        assert.match(tx ?? "", /^````EDIT/);
    } finally { await db.close(); }
});

test("{§log-history-projection}: an individual log event cannot be deleted", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-append-only");
        const id = await minimalLog(db, ctx);
        await assert.rejects(
            () => db.test_log_entries_delete.run({ id }),
            /log entries can only be removed with their containing history/,
        );
        const count = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(count, 1, "the rejected deletion leaves exact evidence intact");
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: weight negative rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-toksneg");
        await assert.rejects(
            () => minimalLog(db, ctx, { weight: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: query log:///<L>/<T>/<A> address pattern", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-address");
        await minimalLog(db, ctx, { sequence: 1 });
        await minimalLog(db, ctx, { sequence: 2, op: "SEND" });
        const row = await db.test_log_entries_address_join.get<{ op: string; loop_seq: number; turn_seq: number; sequence: number }>({ loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(row?.op, "SEND");
        assert.equal(row?.loop_seq, 1);
        assert.equal(row?.turn_seq, 1);
        assert.equal(row?.sequence, 2);
    } finally { await db.close(); }
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
