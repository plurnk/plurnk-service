import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, ReadStatement, ParsedPath, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (opts: { path: ParsedPath; tags?: string[] | null; body?: string | null }): EditStatement => ({
    op: "EDIT", suffix: "",
    signal: opts.tags ?? null,
    path: opts.path,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStmt = (opts: { path: ParsedPath }): ReadStatement => ({
    op: "READ", suffix: "",
    signal: null,
    path: opts.path,
    lineMarker: null,
    body: null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const env = seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, env };
};

test("Engine.dispatch: EDIT against known:// routes to Known.edit, returns 201, writes entry", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ path: urlPath("known", "/france/capital"), body: "Paris", tags: ["france"] }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 201);
        assert.ok((result as unknown as { entryId: number }).entryId >= 1);
        const entry = db.prepare("SELECT pathname FROM entries WHERE id = ?").get((result as unknown as { entryId: number }).entryId) as { pathname: string };
        assert.equal(entry.pathname, "/france/capital");
    } finally { db.close(); }
});

test("Engine.dispatch: writes log_entry with statement + result fields", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ path: urlPath("known", "/x"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        const log = db.prepare("SELECT * FROM log_entries WHERE turn_id = ?").get(env.turnId) as {
            run_id: number; loop_id: number; turn_id: number; action_index: number;
            origin: string; op: string; suffix: string; signal: string | null;
            target_scheme: string | null; target_pathname: string | null;
            tx: string; mimetype_tx: string; rx: string; mimetype_rx: string; status_rx: number;
        };
        assert.equal(log.run_id, env.runId);
        assert.equal(log.loop_id, env.loopId);
        assert.equal(log.turn_id, env.turnId);
        assert.equal(log.action_index, 0);
        assert.equal(log.origin, "model");
        assert.equal(log.op, "EDIT");
        assert.equal(log.suffix, "");
        assert.equal(log.signal, null);
        assert.equal(log.target_scheme, "known");
        assert.equal(log.target_pathname, "/x");
        assert.equal(log.mimetype_tx, "application/json");
        assert.equal(log.mimetype_rx, "application/json");
        assert.equal(log.status_rx, 201);
        const tx = JSON.parse(log.tx) as { op: string };
        assert.equal(tx.op, "EDIT");
        const rx = JSON.parse(log.rx) as { status: number };
        assert.equal(rx.status, 201);
    } finally { db.close(); }
});

test("Engine.dispatch: READ against known:// routes to Known.read", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ path: urlPath("known", "/r"), body: "value" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        const result = await engine.dispatch({
            statement: readStmt({ path: urlPath("known", "/r") }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 1, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal((result as unknown as { content: string }).content, "value");
    } finally { db.close(); }
});

test("Engine.dispatch: unknown scheme returns 501 and still writes log row", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ path: urlPath("wiki", "/x"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 501);
        const log = db.prepare("SELECT status_rx, target_scheme FROM log_entries WHERE turn_id = ?").get(env.turnId) as { status_rx: number; target_scheme: string };
        assert.equal(log.status_rx, 501);
        assert.equal(log.target_scheme, "wiki");
    } finally { db.close(); }
});

test("Engine.dispatch: scheme without matching op method returns 501", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ path: urlPath("plurnk", "/x"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 501, "plurnk scheme exists but has no edit() method yet");
    } finally { db.close(); }
});

test("Engine.dispatch: null path on path-required op returns 400 and logs", async () => {
    const { db, engine, env } = await setup();
    try {
        const stmt: EditStatement = {
            op: "EDIT", suffix: "", signal: null, path: null, lineMarker: null, body: "y",
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: stmt,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 400);
        const log = db.prepare("SELECT status_rx, target_scheme, target_pathname FROM log_entries WHERE turn_id = ?").get(env.turnId) as { status_rx: number; target_scheme: string | null; target_pathname: string | null };
        assert.equal(log.status_rx, 400);
        assert.equal(log.target_scheme, null);
        assert.equal(log.target_pathname, null);
    } finally { db.close(); }
});

test("Engine.dispatch: multiple actions in one turn — log_entries action_index UNIQUE enforced", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ path: urlPath("known", "/a"), body: "1" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        await engine.dispatch({
            statement: editStmt({ path: urlPath("known", "/b"), body: "2" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 1, origin: "model",
        });
        const rows = db.prepare("SELECT action_index, target_pathname FROM log_entries WHERE turn_id = ? ORDER BY action_index").all(env.turnId) as { action_index: number; target_pathname: string }[];
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.action_index, 0);
        assert.equal(rows[0]?.target_pathname, "/a");
        assert.equal(rows[1]?.action_index, 1);
        assert.equal(rows[1]?.target_pathname, "/b");
    } finally { db.close(); }
});

test("Engine.dispatch: signal serialized to JSON in log", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ path: urlPath("known", "/tagged"), tags: ["france", "europe"], body: "Paris" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        const log = db.prepare("SELECT signal FROM log_entries WHERE turn_id = ?").get(env.turnId) as { signal: string };
        assert.deepEqual(JSON.parse(log.signal), ["france", "europe"]);
    } finally { db.close(); }
});

test("Engine.dispatch: origin field captured in log", async () => {
    const { db, engine, env } = await setup();
    try {
        for (const [i, origin] of (["model", "client", "system", "plugin"] as const).entries()) {
            await engine.dispatch({
                statement: editStmt({ path: urlPath("known", `/o${i}`), body: "x" }),
                sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
                actionIndex: i, origin,
            });
        }
        const origins = db.prepare("SELECT origin FROM log_entries WHERE turn_id = ? ORDER BY action_index").all(env.turnId) as { origin: string }[];
        assert.deepEqual(origins.map((r) => r.origin), ["model", "client", "system", "plugin"]);
    } finally { db.close(); }
});
