import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import type { EditStatement, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (target: ParsedPath | null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target,
    lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: urlPath("known", pathname),
    lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "test prompt");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, sessionId, runId, loopId, turnId };
};

test("Log.read: EDIT op log entry returns rx JSON (entryId, channel, status)", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/france", "Paris"),
            sessionId, runId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        const result = await new Log().read(readStmt(urlPath("log", "1/1/1")), makeSchemeCtx({ db, runId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        const rx = JSON.parse(result.content ?? "") as { status: number; channel: string };
        assert.equal(rx.status, 201);
        assert.equal(rx.channel, "body");
    } finally { db.close(); }
});

test("Log.read: each coordinate addresses its own entry's rx", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/a", "1"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt("/b", "2"), sessionId, runId, loopId, turnId, sequence: 2, origin: "model" });
        await engine.dispatch({ statement: editStmt("/c", "3"), sessionId, runId, loopId, turnId, sequence: 3, origin: "model" });

        const r1 = await new Log().read(readStmt(urlPath("log", "1/1/1")), makeSchemeCtx({ db, runId }));
        const r2 = await new Log().read(readStmt(urlPath("log", "1/1/2")), makeSchemeCtx({ db, runId }));
        const r3 = await new Log().read(readStmt(urlPath("log", "1/1/3")), makeSchemeCtx({ db, runId }));
        // Each EDIT created a distinct entry; entryId rises monotonically.
        const id1 = JSON.parse(r1.content ?? "").entryId as number;
        const id2 = JSON.parse(r2.content ?? "").entryId as number;
        const id3 = JSON.parse(r3.content ?? "").entryId as number;
        assert.ok(id1 < id2 && id2 < id3);
    } finally { db.close(); }
});

test("Log.read: cross-loop coordinates within a run resolve correctly", async () => {
    const { db, engine, sessionId, runId, loopId: loop1, turnId: turn1 } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/from-loop-1", "x"), sessionId, runId, loopId: loop1, turnId: turn1, sequence: 1, origin: "model" });

        const loop2 = await insertLoop(db, runId, 2, "second");
        const turn2 = await insertTurn(db, loop2, 1, 200);
        await engine.dispatch({ statement: editStmt("/from-loop-2", "y"), sessionId, runId, loopId: loop2, turnId: turn2, sequence: 1, origin: "model" });

        const r1 = await new Log().read(readStmt(urlPath("log", "1/1/1")), makeSchemeCtx({ db, runId }));
        const r2 = await new Log().read(readStmt(urlPath("log", "2/1/1")), makeSchemeCtx({ db, runId }));
        const id1 = JSON.parse(r1.content ?? "").entryId as number;
        const id2 = JSON.parse(r2.content ?? "").entryId as number;
        assert.ok(id1 !== id2);
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

test("Log.read: lineMarker <1> on a JSON rx returns first item by insertion order (structural <L>)", async () => {
    // EDIT rx is JSON {"status":201,"entryId":N,"channel":"body"}; <L>
    // dispatches on mimetype (application/json), so <1> picks the 1st
    // key-value pair by insertion order, wrapped in an array per the
    // structural-<L> contract.
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/x", "v"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "1/1/1")), lineMarker: { first: 1, last: null } };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, runId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        const items = JSON.parse(r.content ?? "") as Array<Record<string, unknown>>;
        assert.equal(items.length, 1);
        // First key in the rx JSON is "status" (DispatchResult shape).
        assert.equal(items[0].status, 201);
    } finally { db.close(); }
});

test("Log.read: regex body matcher on rx returns N:\\t<value> rows", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/y", "v"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
        // EDIT rx is JSON like {"status":201,"entryId":N,"channel":"body"}.
        // Match the "status" field key in that JSON.
        const stmt: ReadStatement = {
            ...readStmt(urlPath("log", "1/1/1")),
            body: { dialect: "regex", raw: "/\"status\"/", pattern: "\"status\"", flags: "" },
        };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, runId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        assert.match(r.content ?? "", /^\d+:\t"status"$/);
    } finally { db.close(); }
});

test("Log.read: non-empty tag filter → 404 (log has no tag concept)", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/z", "v"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "1/1/1")), signal: ["france"] };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, runId }));
        assert.equal(r.status, 404);
    } finally { db.close(); }
});

test("Log.read: <L> + body matcher composes — slice structural item first, match within", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/x", "v"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
        // <L> dispatches structural on the JSON rx — <1> picks the first
        // kv pair. Then regex matches against that JSON slice. The slice is
        // `[{"status":201}]`; `\d+` extracts the status code.
        const stmt: ReadStatement = {
            ...readStmt(urlPath("log", "1/1/1")),
            lineMarker: { first: 1, last: 1 },
            body: { dialect: "regex", raw: "/\\d+/", pattern: "\\d+", flags: "" },
        };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, runId }));
        assert.equal(r.status, 200);
        assert.match(r.content ?? "", /^\d+:\t201$/);
    } finally { db.close(); }
});

test("Log.read: matcher-then-<L> composition — pick Nth match from a prior READ", async () => {
    // The killer compose-chain: prior READ used a matcher, log entry's rx
    // is `application/json` array of {line,matched} rows. Reading the log
    // entry with <L><N> uses structural <L> to pick the N-th row.
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        const Known = (await import("../../src/schemes/Known.ts")).default;
        await new Known().edit(
            { ...editStmt("/notes", "alpha\nbeta\ngamma"), target: { kind: "url", raw: "known:///notes", scheme: "known", username: null, password: null, hostname: null, port: null, pathname: "/notes", params: {}, fragment: null } },
            { db, sessionId, runId, loopId, turnId, writer: "model", signal: undefined, tokenize: (t: string) => Math.ceil(t.length / 4) },
        );
        // Dispatch a matcher READ — captures all three lines.
        await engine.dispatch({
            statement: {
                op: "READ", suffix: "", signal: null,
                target: { kind: "url", raw: "known:///notes", scheme: "known", username: null, password: null, hostname: null, port: null, pathname: "/notes", params: {}, fragment: null },
                lineMarker: null,
                body: { dialect: "regex", raw: "/\\w+/g", pattern: "\\w+", flags: "g" },
                position: { line: 1, column: 1 },
            },
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        // Now <<READ(log://1/1/1)<2>::READ — structural <L> on the JSON array,
        // picking the 2nd match row.
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "1/1/1")), lineMarker: { first: 2, last: null } };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, runId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        // Result is the 2nd match line (beta).
        assert.match(r.content ?? "", /:\tbeta/);
        assert.doesNotMatch(r.content ?? "", /alpha|gamma/);
    } finally { db.close(); }
});

test("Log.read: dispatches correctly via Engine.dispatch routing to log scheme", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/known-fact", "knowledge"),
            sessionId, runId, loopId, turnId,
            sequence: 1, origin: "model",
        });

        const result = await engine.dispatch({
            statement: readStmt(urlPath("log", "1/1/1")),
            sessionId, runId, loopId, turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        // Log unwrap returns the EDIT rx as JSON; check for status field.
        const rx = JSON.parse((result as unknown as { content: string }).content) as { status: number };
        assert.equal(rx.status, 201);
    } finally { db.close(); }
});
