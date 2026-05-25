import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import type { EditStatement, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (path: ParsedPath | null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, path,
    lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    path: urlPath("known", pathname),
    lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "test prompt");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, sessionId, runId, loopId, turnId };
};

test("Log.read: coordinate lookup retrieves the right log entry", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/france", "Paris"),
            sessionId, runId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        const result = await new Log().read(readStmt(urlPath("log", "1/1/1")), makeSchemeCtx({ db, runId }));
        assert.equal(result.status, 200);
        assert.ok(result.content !== null);
        assert.match(result.content, /EDIT/);
        assert.match(result.content, /known:\/\/\/france/);
        assert.match(result.content, /status: 201/);
        assert.equal(result.mimetype, "text/plain");
    } finally { db.close(); }
});

test("Log.read: coordinates resolve through (loop_seq, turn_seq, sequence) within a run", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        // multiple ops in turn 1 of loop 1
        await engine.dispatch({ statement: editStmt("/a", "1"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt("/b", "2"), sessionId, runId, loopId, turnId, sequence: 2, origin: "model" });
        await engine.dispatch({ statement: editStmt("/c", "3"), sessionId, runId, loopId, turnId, sequence: 3, origin: "model" });

        const r1 = await new Log().read(readStmt(urlPath("log", "1/1/1")), makeSchemeCtx({ db, runId }));
        const r2 = await new Log().read(readStmt(urlPath("log", "1/1/2")), makeSchemeCtx({ db, runId }));
        const r3 = await new Log().read(readStmt(urlPath("log", "1/1/3")), makeSchemeCtx({ db, runId }));
        assert.match(r1.content ?? "", /known:\/\/\/a/);
        assert.match(r2.content ?? "", /known:\/\/\/b/);
        assert.match(r3.content ?? "", /known:\/\/\/c/);
    } finally { db.close(); }
});

test("Log.read: cross-loop coordinates within a run resolve correctly", async () => {
    const { db, engine, sessionId, runId, loopId: loop1, turnId: turn1 } = await setup();
    try {
        // loop1/turn1 already exists from setup(); dispatch a log there
        await engine.dispatch({ statement: editStmt("/from-loop-1", "x"), sessionId, runId, loopId: loop1, turnId: turn1, sequence: 1, origin: "model" });

        // Add a second loop with its own turn 1, dispatch a different log there
        const loop2 = await insertLoop(db, runId, 2, "second");
        const turn2 = await insertTurn(db, loop2, 1, 200);
        await engine.dispatch({ statement: editStmt("/from-loop-2", "y"), sessionId, runId, loopId: loop2, turnId: turn2, sequence: 1, origin: "model" });

        const r1 = await new Log().read(readStmt(urlPath("log", "1/1/1")), makeSchemeCtx({ db, runId }));
        const r2 = await new Log().read(readStmt(urlPath("log", "2/1/1")), makeSchemeCtx({ db, runId }));
        assert.match(r1.content ?? "", /from-loop-1/);
        assert.match(r2.content ?? "", /from-loop-2/);
    } finally { db.close(); }
});

test("Log.read: 404 on missing coordinates", async () => {
    const { db } = await setup();
    try {
        const result = await new Log().read(readStmt(urlPath("log", "99/99/99")), makeSchemeCtx({ db, runId: 1 }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

test("Log.read: 400 on malformed coordinates", async () => {
    const { db } = await setup();
    try {
        for (const bad of ["abc", "1/2", "1/2/3/4", "x/y/z"]) {
            const result = await new Log().read(readStmt(urlPath("log", bad)), makeSchemeCtx({ db, runId: 1 }));
            assert.equal(result.status, 400, `path '${bad}' should return 400`);
        }
    } finally { db.close(); }
});

test("Log.read: 400 on null path", async () => {
    const { db } = await setup();
    try {
        const result = await new Log().read(readStmt(null), makeSchemeCtx({ db, runId: 1 }));
        assert.equal(result.status, 400);
    } finally { db.close(); }
});

test("Log.read: 501 on lineMarker / body matcher / non-empty tag filter", async () => {
    const { db } = await setup();
    try {
        const lineMarker: ReadStatement = { ...readStmt(urlPath("log", "1/1/0")), lineMarker: { first: 1, last: null } };
        const body: ReadStatement = { ...readStmt(urlPath("log", "1/1/0")), body: { dialect: "glob", raw: "*" } };
        const tags: ReadStatement = { ...readStmt(urlPath("log", "1/1/0")), signal: ["france"] };
        const log = new Log();
        assert.equal((await log.read(lineMarker, makeSchemeCtx({ db, runId: 1 }))).status, 501);
        assert.equal((await log.read(body, makeSchemeCtx({ db, runId: 1 }))).status, 501);
        assert.equal((await log.read(tags, makeSchemeCtx({ db, runId: 1 }))).status, 501);
    } finally { db.close(); }
});

test("Log.read: dispatches correctly via Engine.dispatch routing to log scheme", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        // Write a log entry
        await engine.dispatch({
            statement: editStmt("/known-fact", "knowledge"),
            sessionId, runId, loopId, turnId,
            sequence: 1, origin: "model",
        });

        // Now dispatch a READ on log://1/1/1 — engine routes to Log.read
        const result = await engine.dispatch({
            statement: readStmt(urlPath("log", "1/1/1")),
            sessionId, runId, loopId, turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.match((result as unknown as { content: string }).content, /EDIT/);
    } finally { db.close(); }
});
