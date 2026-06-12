import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, ReadStatement, KillStatement, ParsedPath, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (opts: { target: ParsedPath; tags?: string[] | null; body?: string | null }): EditStatement => ({
    op: "EDIT", suffix: "",
    signal: opts.tags ?? null,
    target: opts.target,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStmt = (opts: { target: ParsedPath }): ReadStatement => ({
    op: "READ", suffix: "",
    signal: null,
    target: opts.target,
    lineMarker: null,
    body: null,
    position: { line: 1, column: 1 },
});

const killStmt = (opts: { target: ParsedPath; body?: string | null }): KillStatement => ({
    op: "KILL", suffix: "",
    signal: null,
    target: opts.target,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

test("Engine.dispatch: KILL against known:// permanently deletes the entry (200, then READ 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("known", "/obsolete/note"), body: "stale" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("known", "/obsolete/note") }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200);
        const read = await engine.dispatch({
            statement: readStmt({ target: urlPath("known", "/obsolete/note") }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId, sequence: 3, origin: "model",
        });
        assert.equal(read.status, 404);
    } finally { await db.close(); }
});

test("Engine.dispatch: KILL on a nonexistent entry returns 404", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("known", "/never/existed") }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(kill.status, 404);
    } finally { await db.close(); }
});

test("Engine.dispatch: the KILL body annotation survives into the log row's tx (even on a 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: killStmt({ target: urlPath("known", "/gone"), body: "superseded — see /final" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const log = await (db.test_first_log_entry_for_turn as PrepMethod).get<{ op: string; tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("KILL log_entry not found");
        assert.equal(log.op, "KILL");
        const tx = JSON.parse(log.tx) as { body: string | null };
        assert.equal(tx.body, "superseded — see /final");
    } finally { await db.close(); }
});

test("Engine.dispatch: KILL against exec:// returns 501 (process-KILL pending the addressable-process design)", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("exec", "/sh/1/1/2") }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(kill.status, 501);
    } finally { await db.close(); }
});

test("Engine.dispatch: KILL against log:// returns 405 (append-only)", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/0") }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "system",
        });
        assert.equal(kill.status, 405);
    } finally { await db.close(); }
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, env };
};

test("[§3.3-op-dispatch] Engine.dispatch: EDIT against known:// routes to Known.edit, returns 201, writes entry", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("known", "/france/capital"), body: "Paris", tags: ["france"] }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const entryId = (result as unknown as { entryId: number }).entryId;
        assert.ok(entryId >= 1);
        const entry = await (db.test_get_entry_by_id as PrepMethod).get<{ pathname: string }>({ id: entryId });
        assert.equal(entry?.pathname, "/france/capital");
    } finally { await db.close(); }
});

test("Engine.dispatch: writes log_entry with statement + result fields", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("known", "/x"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await (db.test_first_log_entry_for_turn as PrepMethod).get<{
            run_id: number; loop_id: number; turn_id: number; sequence: number;
            origin: string; op: string; suffix: string; signal: string | null;
            scheme: string | null; pathname: string | null;
            tx: string; mimetype_tx: string; rx: string; mimetype_rx: string; status_rx: number;
        }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("log_entry not found");
        assert.equal(log.run_id, env.runId);
        assert.equal(log.loop_id, env.loopId);
        assert.equal(log.turn_id, env.turnId);
        assert.equal(log.sequence, 1);
        assert.equal(log.origin, "model");
        assert.equal(log.op, "EDIT");
        assert.equal(log.suffix, "");
        assert.equal(log.signal, null);
        assert.equal(log.scheme, "known");
        assert.equal(log.pathname, "/x");
        assert.equal(log.mimetype_tx, "application/json");
        assert.equal(log.mimetype_rx, "application/json");
        assert.equal(log.status_rx, 201);
        const tx = JSON.parse(log.tx) as { op: string };
        assert.equal(tx.op, "EDIT");
        const rx = JSON.parse(log.rx) as { status: number };
        assert.equal(rx.status, 201);
    } finally { await db.close(); }
});

test("Engine.dispatch: READ against known:// routes to Known.read", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("known", "/r"), body: "value" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("known", "/r") }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal((result as unknown as { content: string }).content, "value");
    } finally { await db.close(); }
});

test("Engine.dispatch: unknown scheme returns 501 and still writes log row", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("wiki", "/x"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        const log = await (db.test_first_log_entry_for_turn as PrepMethod).get<{ status_rx: number; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 501);
        assert.equal(log?.scheme, "wiki");
    } finally { await db.close(); }
});

test("Engine.dispatch: null path on path-required op returns 400 and logs", async () => {
    const { db, engine, env } = await setup();
    try {
        const stmt: EditStatement = {
            op: "EDIT", suffix: "", signal: null, target: null, lineMarker: null, body: "y",
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: stmt,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
        const log = await (db.test_first_log_entry_for_turn as PrepMethod).get<{ status_rx: number; scheme: string | null; pathname: string | null }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 400);
        assert.equal(log?.scheme, null);
        assert.equal(log?.pathname, null);
    } finally { await db.close(); }
});

test("Engine.dispatch: multiple actions in one turn — log_entries sequence UNIQUE enforced", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("known", "/a"), body: "1" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        await engine.dispatch({
            statement: editStmt({ target: urlPath("known", "/b"), body: "2" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        const rows = await (db.test_log_entries_by_turn as PrepMethod).all<{ sequence: number; pathname: string }>({ turn_id: env.turnId });
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.sequence, 1);
        assert.equal(rows[0]?.pathname, "/a");
        assert.equal(rows[1]?.sequence, 2);
        assert.equal(rows[1]?.pathname, "/b");
    } finally { await db.close(); }
});

test("Engine.dispatch: signal serialized to JSON in log", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("known", "/tagged"), tags: ["france", "europe"], body: "Paris" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await (db.test_first_log_entry_for_turn as PrepMethod).get<{ signal: string }>({ turn_id: env.turnId });
        assert.deepEqual(JSON.parse(log?.signal ?? "null"), ["france", "europe"]);
    } finally { await db.close(); }
});

test("Engine.dispatch: origin field captured in log", async () => {
    const { db, engine, env } = await setup();
    try {
        for (const [i, origin] of (["model", "client", "system", "plugin"] as const).entries()) {
            await engine.dispatch({
                statement: editStmt({ target: urlPath("known", `/o${i}`), body: "x" }),
                sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
                sequence: i + 1, origin,
            });
        }
        const rows = await (db.test_log_entries_by_turn as PrepMethod).all<{ origin: string; sequence: number }>({ turn_id: env.turnId });
        assert.deepEqual(rows.map((r) => r.origin), ["model", "client", "system", "plugin"]);
    } finally { await db.close(); }
});

// SPEC §3.6: writer must be in target scheme's manifest.writableBy or dispatch
// returns 403 without invoking the handler.

test("[§3.6-writableby-403] Engine.dispatch: model EDIT log:// rejected with 403 (Log.writableBy=['system'])", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("log", "/x"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
        assert.match((result as unknown as { error: string }).error, /writer 'model'.*'log'/);
        // 403 still writes a log row
        const log = await (db.test_first_log_entry_for_turn as PrepMethod).get<{ status_rx: number; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 403);
        assert.equal(log?.scheme, "log");
    } finally { await db.close(); }
});

test("Engine.dispatch: model EDIT plurnk://prompt/* rejected with 403 (engine/client own prompts)", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("plurnk", "prompt/1"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
    } finally { await db.close(); }
});

test("Engine.dispatch: model EDIT plurnk:// non-prompt path is allowed", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("plurnk", "scratch"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
    } finally { await db.close(); }
});

test("Engine.dispatch: model READ log:// is NOT gated by writableBy (read-side op)", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log scheme has no read() handler yet, so this returns 501 — proves
        // the writableBy gate did NOT intercept (would have returned 403).
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("log", "/x") }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("Engine.dispatch: system EDIT log:// is allowed by writableBy", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log has no edit() handler — so this returns 501 (not 403) when allowed.
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("log", "/x"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "system",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("Engine.dispatch: model SEND with null path (broadcast) is NOT gated", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: { op: "SEND", suffix: "", signal: 200, target: null, lineMarker: null, body: null, position: { line: 1, column: 1 } },
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

// SPEC §3.6 / plurnk-schemes#1: action-entry-as-outcome — scheme-handler
// exceptions finalize the action-entry at 500, not bubble up.

test("[§3.6-exception-500] Engine.dispatch: scheme handler that throws → action-entry at status 500 (action-entry-as-outcome)", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    class Boom {
        static manifest = {
            name: "boom", channels: {}, defaultChannel: "",
            category: "data" as const, scope: "session" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async edit() { throw new Error("scheme handler deliberately threw"); }
    }
    schemes.register("boom", new Boom());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("boom", "/x"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.match((result as unknown as { error: string }).error, /scheme handler deliberately threw/);
        // action-entry preserved at status 500 with error in rx
        const log = await (db.test_first_log_entry_for_turn as PrepMethod).get<{ status_rx: number; rx: string; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 500);
        assert.equal(log?.scheme, "boom");
        const rx = JSON.parse(log?.rx ?? "{}");
        assert.equal(rx.status, 500);
        assert.match(rx.error, /scheme handler deliberately threw/);
    } finally { await db.close(); }
});

test("Engine.dispatch: non-Error throw (string) → action-entry at 500 with stringified message", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    class BoomString {
        static manifest = {
            name: "boomstr", channels: {}, defaultChannel: "",
            category: "data" as const, scope: "session" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async edit(): Promise<never> { throw "raw string thrown"; }
    }
    schemes.register("boomstr", new BoomString());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("boomstr", "/x"), body: "y" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.equal((result as unknown as { error: string }).error, "raw string thrown");
    } finally { await db.close(); }
});

test("Engine.dispatch: model COPY into log:// destination rejected with 403", async () => {
    const { db, engine, env } = await setup();
    try {
        // Source first: model creates an entry in known://.
        await engine.dispatch({
            statement: editStmt({ target: urlPath("known", "/src"), body: "v" }),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        // Attempt copy known://src → log://dst — destination scheme rejects.
        const result = await engine.dispatch({
            statement: {
                op: "COPY", suffix: "", signal: null,
                target: urlPath("known", "/src"),
                lineMarker: null,
                body: urlPath("log", "/dst"),
                position: { line: 1, column: 1 },
            },
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 403);
    } finally { await db.close(); }
});
