import test from "node:test";
import Worker from "../../src/schemes/Worker.ts";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import type { EditStatement, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

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

test("Log.read: EDIT op log entry returns rx JSON (entryId, channel, status)", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/france", "Paris"),
            workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        const result = await new Log().read(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        const rx = JSON.parse(result.content ?? "") as { status: number; channel: string };
        assert.equal(rx.status, 201);
        assert.equal(rx.channel, "body");
    } finally { db.close(); }
});

test("Log.read: each coordinate addresses its own entry's rx", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/a", "1"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt("/b", "2"), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        await engine.dispatch({ statement: editStmt("/c", "3"), workspaceId, workerId, loopId, turnId, sequence: 3, origin: "model" });

        const r1 = await new Log().read(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workerId }));
        const r2 = await new Log().read(readStmt(urlPath("log", "/1/1/2")), makeSchemeCtx({ db, workerId }));
        const r3 = await new Log().read(readStmt(urlPath("log", "/1/1/3")), makeSchemeCtx({ db, workerId }));
        // Each EDIT created a distinct entry; entryId rises monotonically.
        const id1 = JSON.parse(r1.content ?? "").entryId as number;
        const id2 = JSON.parse(r2.content ?? "").entryId as number;
        const id3 = JSON.parse(r3.content ?? "").entryId as number;
        assert.ok(id1 < id2 && id2 < id3);
    } finally { db.close(); }
});

test("Log.read: cross-loop coordinates within a worker resolve correctly", async () => {
    const { db, engine, workspaceId, workerId, loopId: loop1, turnId: turn1 } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/from-loop-1", "x"), workspaceId, workerId, loopId: loop1, turnId: turn1, sequence: 1, origin: "model" });

        const loop2 = await insertLoop(db, workerId, 2, "second");
        const turn2 = await insertTurn(db, loop2, 1, 200);
        await engine.dispatch({ statement: editStmt("/from-loop-2", "y"), workspaceId, workerId, loopId: loop2, turnId: turn2, sequence: 1, origin: "model" });

        const r1 = await new Log().read(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workerId }));
        const r2 = await new Log().read(readStmt(urlPath("log", "/2/1/1")), makeSchemeCtx({ db, workerId }));
        const id1 = JSON.parse(r1.content ?? "").entryId as number;
        const id2 = JSON.parse(r2.content ?? "").entryId as number;
        assert.ok(id1 !== id2);
    } finally { db.close(); }
});

test("Log.read: 404 on missing coordinates", async () => {
    const { db } = await setup();
    try {
        const result = await new Log().read(readStmt(urlPath("log", "/99/99/99")), makeSchemeCtx({ db, workerId: 1 }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

test("Log.read: 400 on malformed coordinates", async () => {
    const { db } = await setup();
    try {
        for (const bad of ["abc", "1/2", "1/2/3/4", "x/y/z"]) {
            const result = await new Log().read(readStmt(urlPath("log", bad)), makeSchemeCtx({ db, workerId: 1 }));
            assert.equal(result.status, 400, `path '${bad}' should return 400`);
        }
    } finally { db.close(); }
});

test("Log.read: 400 on null path", async () => {
    const { db } = await setup();
    try {
        const result = await new Log().read(readStmt(null), makeSchemeCtx({ db, workerId: 1 }));
        assert.equal(result.status, 400);
    } finally { db.close(); }
});

test("Log.read: lineMarker <1> on a JSON rx returns first item by insertion order (structural <L>)", async () => {
    // EDIT rx is JSON {"status":201,"entryId":N,"channel":"body"}; <L>
    // dispatches on mimetype (application/json), so <1> picks the 1st
    // key-value pair by insertion order, wrapped in an array per the
    // structural-<L> contract.
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/x", "v"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/1")), lineMarker: { marks: [1] } };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, workerId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        const items = JSON.parse(r.content ?? "") as Array<Record<string, unknown>>;
        assert.equal(items.length, 1);
        // First key in the rx JSON is "status" (DispatchResult shape).
        assert.equal(items[0].status, 201);
    } finally { db.close(); }
});

test("Log.read: a range miss carries the exact JSON-item extent", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/x", "v"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/1")), lineMarker: { marks: [99] } };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, workerId }));
        assert.equal(r.status, 416);
        assert.equal(r.content, null);
        const range = r.problem?.range as {
            unit?: string;
            requested?: { first?: number };
            available?: { total?: number };
        };
        assert.equal(range.unit, "item");
        assert.equal(range.requested?.first, 99);
        assert.ok(Number(range.available?.total) > 0);
    } finally { db.close(); }
});

test("Log.read: regex body matcher returns the complete projection plus coordinates", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/y", "v"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        // EDIT rx is JSON like {"status":201,"entryId":N,"channel":"body"}.
        // Match the "status" field key in that JSON.
        const stmt: ReadStatement = {
            ...readStmt(urlPath("log", "/1/1/1")),
            body: { dialect: "regex", raw: "/\"status\"/", pattern: "\"status\"", flags: "" },
        };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, workerId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.match(r.content ?? "", /"status"\s*:\s*201/);
        assert.ok((r.matches?.length ?? 0) > 0);
    } finally { db.close(); }
});

test("Log.read: a tag filter on an exact READ → 404 (tag recall is OPEN[tag]/FIND[tag]'s job, )", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/z", "v"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        const stmt: ReadStatement = { ...readStmt(urlPath("log", "/1/1/1")), signal: ["france"] };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, workerId }));
        assert.equal(r.status, 404);
    } finally { db.close(); }
});

test("Log.read: body matcher selects the full projection before <L> projects a structural item", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({ statement: editStmt("/x", "v"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        // The matcher qualifies the complete JSON rx. <1> then projects its
        // first structural item instead of paginating matcher hits.
        const stmt: ReadStatement = {
            ...readStmt(urlPath("log", "/1/1/1")),
            lineMarker: { marks: [1, 1] },
            body: { dialect: "regex", raw: "/\\d+/", pattern: "\\d+", flags: "" },
        };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, workerId }));
        assert.equal(r.status, 200);
        assert.match(r.content ?? "", /"status"\s*:\s*201/);
        assert.ok((r.matches?.length ?? 0) > 0);
    } finally { db.close(); }
});

test("Log.read: a matcher READ writes one resource row with surgical coordinates", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await new Worker().edit(
            { ...editStmt("/notes", "alpha\nbeta\ngamma"), target: { kind: "url", raw: "worker:///notes", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/notes", params: {}, fragment: null } },
            { db, workspaceId, workerId, loopId, turnId, writer: "model", signal: undefined, tokenize: (t: string) => Math.ceil(t.length / 4) },
        );
        const result = await engine.dispatch({
            statement: {
                op: "READ", suffix: "", signal: null,
                target: { kind: "url", raw: "worker:///notes", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/notes", params: {}, fragment: null },
                lineMarker: null,
                body: { dialect: "regex", raw: "/\\w+/g", pattern: "\\w+", flags: "g" },
                position: { line: 1, column: 1 },
            },
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.rowsWritten ?? 1, 1);
        const r = await new Log().read(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, workerId }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        assert.equal(r.content, "alpha\nbeta\ngamma");
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
        // Log unwrap returns the EDIT rx as JSON; check for status field.
        const rx = JSON.parse((result as unknown as { content: string }).content) as { status: number };
        assert.equal(rx.status, 201);
    } finally { db.close(); }
});
