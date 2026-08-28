import test from "node:test";
import Worker from "../../src/schemes/Worker.ts";
import assert from "node:assert/strict";
import type { FindStatement, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, readLog, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { matchLocations } from "./_find.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const readStmt = (target: ParsedPath | null): ReadStatement => ({
    metadata: null,
    op: "READ", annotation: null, delimiter: "", signal: null, target,
    lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const editStmt = (pathname: string, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", annotation: null, delimiter: "", signal: null,
    target: urlPath("worker", pathname),
    lineMarker: null, body,
    position: { line: 1, column: 1 },
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

test("Log.read: EDIT op log entry returns its canonical effect receipt", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/france", "Paris"),
            workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        const result = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.content, "1:Paris", "storage envelope fields do not replace the model-facing edit result");
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
        const correct = await readLog(readStmt(urlPath("log", "/1/1/1/EDIT")), makeSchemeCtx({ db, workerId }));
        const wrong = await readLog(readStmt(urlPath("log", "/1/1/1/READ")), makeSchemeCtx({ db, workerId }));
        assert.equal(correct.status, 200);
        assert.equal(wrong.status, 404);
    } finally { db.close(); }
});

test("Log.read: each coordinate addresses its own canonical body", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/a", "1"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt("/b", "2"), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        await engine.dispatch({ statement: editStmt("/c", "3"), workspaceId, workerId, loopId, turnId, sequence: 3, origin: "model" });

        const r1 = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workerId }));
        const r2 = await readLog(readStmt(urlPath("log", "/1/1/2")), makeSchemeCtx({ db, workerId }));
        const r3 = await readLog(readStmt(urlPath("log", "/1/1/3")), makeSchemeCtx({ db, workerId }));
        assert.deepEqual(
            [r1.content, r2.content, r3.content],
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

        const r1 = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workerId }));
        const r2 = await readLog(readStmt(urlPath("log", "/2/1/1")), makeSchemeCtx({ db, workerId }));
        assert.equal(r1.content, "1:x");
        assert.equal(r2.content, "1:y");
    } finally { db.close(); }
});

test("Log.read: 404 on missing coordinates", async () => {
    const { db } = await setup();
    try {
        const result = await readLog(readStmt(urlPath("log", "/99/99/99")), makeSchemeCtx({ db, workerId: 1 }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

test("Log.read: 400 on malformed coordinates", async () => {
    const { db } = await setup();
    try {
        for (const bad of ["abc", "1/2", "1/2/3/4", "x/y/z"]) {
            const result = await readLog(readStmt(urlPath("log", bad)), makeSchemeCtx({ db, workerId: 1 }));
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
        }), makeSchemeCtx({ db, workerId }));
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/log/channel-not-found");
    } finally { db.close(); }
});

test("Log.read: 400 on null path", async () => {
    const { db } = await setup();
    try {
        const result = await readLog(readStmt(null), makeSchemeCtx({ db, workerId: 1 }));
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
            makeSchemeCtx({ db, workerId }),
        );
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/2")), lineMarker: { marks: [1] } };
        const r = await readLog(stmt, makeSchemeCtx({ db, workerId }));
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
        const r = await readLog(stmt, makeSchemeCtx({ db, workerId }));
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
            op: "FIND", annotation: null, delimiter: "", signal: null, target: urlPath("log", "/1/1/2"), lineMarker: null,
            body: { dialect: "regex", raw: "/\"status\"/", pattern: "\"status\"", flags: "" }, position: { line: 1, column: 1 },
        };
        const r = await new Log().find(stmt, makeSchemeCtx({ db, workerId }));
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
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/1")), signal: ["+france"] };
        const result = await readLog(stmt, makeSchemeCtx({ db, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "1:v");
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
            op: "FIND", annotation: null, delimiter: "", signal: null, target: urlPath("log", "/1/1/2"),
            lineMarker: { marks: [1, 1] },
            body: { dialect: "regex", raw: "/\\d+/", pattern: "\\d+", flags: "" }, position: { line: 1, column: 1 },
        };
        const r = await new Log().find(stmt, makeSchemeCtx({ db, workerId }));
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
                op: "FIND", annotation: null, delimiter: "", signal: null,
                target: { kind: "url", raw: "worker:///notes", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/notes", query: null, fragment: null },
                lineMarker: null,
                body: { dialect: "regex", raw: "/\\w+/g", pattern: "\\w+", flags: "g" },
                position: { line: 1, column: 1 },
            },
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.rowsWritten ?? 1, 1);
        const r = await readLog(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workerId }));
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
        assert.equal((result as unknown as { content: string }).content, "1:knowledge");
    } finally { db.close(); }
});
