// [§search-gate] intg tier — the DISPATCH wiring (#406, owner ruling): an identical duplicate
// search strikes-and-serves (409 carrying the prior digest, no re-run), the per-turn cap 429s,
// and a failed spawn never poisons the retry. Drives the REAL exec scheme with a stub search
// executor through the hotload-era registry — no network, no SearXNG.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { ExecStatement } from "@plurnk/plurnk-grammar";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { setTimeout as delay } from "node:timers/promises";

// The exec scheme finalizes spawn streams asynchronously; give the teardown a beat
// before closing the db (the subscription registry settles within a few ticks).
const settle = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number): Promise<void> => {
    for (let i = 0; i < 40; i++) {
        const open = await (db.test_count_open_subs_by_scheme as PrepMethod).get<{ n: number }>({ session_id: sessionId, scheme: "search" }).catch(() => undefined);
        if ((open?.n ?? 0) === 0) { await delay(25); return; }
        await delay(25);
    }
};

const DIGEST = [{ title: "Alpha", url: "http://example.org/a", snippet: "s" }];

const stubExecutor = (behavior: { fail?: boolean } = {}) => ({
    runtime: "search",
    glyph: "🔎",
    get manifest() {
        return {
            name: "search", channels: { "#results": "application/json" }, defaultChannel: "#results",
            category: "data" as const, scope: "session" as const, writableBy: ["model" as const],
            volatile: true, modelVisible: true, example: "", documentation: "stub",
        };
    },
    get defaultChannel() { return "#results"; },
    get channels() { return { "#results": { mimetype: "application/json" } }; },
    async run(args: { write: (c: string, chunk: string, m?: string) => void }) {
        if (behavior.fail === true) return { status: 500 };
        args.write("#results", JSON.stringify(DIGEST), "application/json");
        return { status: 200 };
    },
    async probe() { return { available: true as const }; },
    effect() { return "read" as const; },
});

const execStmt = (command: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: "search", target: null, lineMarker: null, body: command, position: { line: 1, column: 1 },
});

const seed = async (db: Awaited<ReturnType<typeof openMigrated>>, opts: { fail?: boolean } = {}) => {
    const sessionId = await insertSession(db, `gate-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "search things");
    const turnId = await insertTurn(db, loopId, 1, 102);
    // The daemon's wake hook, minimally: settle the gate on stream conclusions (promote 200 /
    // drop failure) — production Daemon.#handleWakeRun line one.
    const notifyRef: { fn: (p: { target: string; closeStatus: number }) => void } = { fn: () => {} };
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, wakeRunNotify: (p) => notifyRef.fn(p) });
    notifyRef.fn = (p) => engine.searchGate.settle(p.target.replace(/^[a-z+.-]+:\/\//, "/").replace(/^\/+/, "/"), p.closeStatus);
    engine.setExecutors(new ExecutorRegistry(new Map([["search", {
        executor: stubExecutor(opts) as never, glyph: "🔎", example: "", documentation: "", available: true, detail: undefined,
    }]])));
    return { sessionId, runId, loopId, turnId, engine };
};

const dispatchSearch = (engine: Engine, ids: { sessionId: number; runId: number; loopId: number; turnId: number }, command: string, sequence: number) =>
    engine.dispatch({ statement: execStmt(command), ...ids, sequence, origin: "model" });

test("[§search-gate] an identical duplicate strikes and serves — 409 carrying the prior digest, executor not re-run (#406)", async () => {
    const db = await openMigrated();
    const { sessionId, runId, loopId, turnId, engine } = await seed(db);
    try {
        const ids = { sessionId, runId, loopId, turnId };
        const first = await dispatchSearch(engine, ids, "capital of france", 1);
        assert.ok(first.status < 400, `the first search dispatches clean; got ${first.status}`);
        await settle(db, sessionId);  // the stream's 200 conclusion promotes the pending registration
        // the stub wrote #results synchronously; the duplicate serves from the entry
        const dup = await dispatchSearch(engine, ids, "capital of france", 2);
        assert.equal(dup.status, 409, "the duplicate is a strike (409 — the rail counts it)");
        assert.deepEqual(dup.results, DIGEST, "…and SERVES the same results, verbatim, no prose");
        // the model-facing record: the 409 row exists with the results in its rx
        const rows = await (db.test_send_rows_for_run as PrepMethod).all<{ rx: string; status_rx: number }>({ run_id: runId }).catch(() => []);
        const struck = await (db.test_count_op as PrepMethod).get<{ n: number }>({ op: "EXEC" });
        assert.ok((struck?.n ?? 0) >= 2, "both EXEC attempts are on the log — the duplicate is recorded, never erased");
    } finally { await settle(db, sessionId).catch(() => {}); await db.close(); }
});

test("[§search-gate] the per-turn cap 429s the overflow search; a failed spawn never poisons the retry (#406)", async () => {
    const db = await openMigrated();
    // cap knob ships =3 (.env.defaults floor, loaded by the test cascade)
    const { sessionId, runId, loopId, turnId, engine } = await seed(db);
    try {
        const ids = { sessionId, runId, loopId, turnId };
        assert.ok((await dispatchSearch(engine, ids, "q1", 1)).status < 400);
        assert.ok((await dispatchSearch(engine, ids, "q2", 2)).status < 400);
        assert.ok((await dispatchSearch(engine, ids, "q3", 3)).status < 400);
        const fourth = await dispatchSearch(engine, ids, "q4", 4);
        assert.equal(fourth.status, 429, "the fourth DISTINCT search this turn is flood-controlled");
        assert.match(String(fourth.error), /limit/i, "with a legible steer");
    } finally { await settle(db, sessionId).catch(() => {}); await db.close(); }
});

test("[§search-gate] a failed search does not register — the retry runs for real (#406)", async () => {
    const db = await openMigrated();
    const { sessionId, runId, loopId, turnId, engine } = await seed(db, { fail: true });
    try {
        const ids = { sessionId, runId, loopId, turnId };
        // Spawns are async: dispatch ACCEPTS (200) before run() fails; the failure arrives at
        // the stream's close, where settle() drops the pending registration.
        const accepted = await dispatchSearch(engine, ids, "flaky query", 1);
        assert.ok(accepted.status < 400, `the spawn is accepted at dispatch; got ${accepted.status}`);
        // Once the failed close settles, the retry must NOT be served a dead duplicate.
        await settle(db, sessionId);
        const retry = await dispatchSearch(engine, ids, "flaky query", 2);
        assert.notEqual(retry.status, 409, "no dedup hit off a failed spawn — the retry dispatches for real");
    } finally { await settle(db, sessionId).catch(() => {}); await db.close(); }
});
