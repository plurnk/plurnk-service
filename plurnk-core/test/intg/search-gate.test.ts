// {§search-gate} integration tier: an identical duplicate
// search strikes-and-serves (409 carrying the prior digest, no re-run), the per-turn cap 429s,
// and a failed spawn never poisons the retry. Drives the REAL exec scheme with a stub search
// executor through the runtime registry - no network, no SearXNG.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import Results from "../../src/core/results.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { setTimeout as delay } from "node:timers/promises";

// The exec scheme finalizes spawn streams asynchronously; give the teardown a beat
// before closing the db (the subscription registry settles within a few ticks).
const settle = async (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number): Promise<void> => {
    for (let i = 0; i < 40; i++) {
        const open = await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "search" });
        if ((open?.n ?? 0) === 0) { await delay(25); return; }
        await delay(25);
    }
    throw new Error("search fixture stream did not settle within 1 second");
};

const DIGEST = [{ title: "Alpha", url: "http://example.org/a", snippet: "s" }];

const stubExecutor = (behavior: { fail?: boolean } = {}) => ({
    runtime: "search",
    glyph: "🔎",
    get manifest() {
        return {
            name: "search", channels: { "#results": "application/json" }, defaultChannel: "#results",
            category: "data" as const, writableBy: ["model" as const],
            volatile: true, modelVisible: true, example: "", documentation: "stub",
        };
    },
    get defaultChannel() { return "#results"; },
    get channels() { return { "#results": { mimetype: "application/json" } }; },
    async run(args: { write: (c: string, chunk: string, m?: string) => void }) {
        if (behavior.fail === true) {
            return Results.failure(
                "executor:search-fixture",
                "request-failed",
                500,
                "The search fixture request failed.",
                {},
                { stage: "execute", retryable: true },
            );
        }
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
    const workspaceId = await insertWorkspace(db, `gate-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "search things");
    const turnId = await insertTurn(db, loopId, 1, 102);
    // The daemon's wake hook, minimally: settle the gate on stream conclusions (promote 200 /
    // drop failure) — production Daemon.#handleWakeWorker line one.
    const notifyRef: { fn: (p: { target: string; result: { status: number } }) => void } = { fn: () => {} };
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, wakeWorkerNotify: (p) => notifyRef.fn(p) });
    notifyRef.fn = (p) => engine.searchGate.settle(p.target.replace(/^[a-z+.-]+:\/\//, "/").replace(/^\/+/, "/"), p.result.status);
    engine.setExecutors(new ExecutorRegistry(new Map([["search", {
        executor: stubExecutor(opts) as never, namespaceOwner: { kind: "module", name: "search-gate fixture" }, glyph: "🔎", example: "", documentation: "", available: true, detail: undefined,
    }]])));
    return { workspaceId, workerId, loopId, turnId, engine };
};

const dispatchSearch = (engine: Engine, ids: { workspaceId: number; workerId: number; loopId: number; turnId: number }, command: string, sequence: number) =>
    engine.dispatch({ statement: execStmt(command), ...ids, sequence, origin: "model" });

test("{§search-gate}: an identical duplicate strikes, serves, and does not rerun", async () => {
    const db = await openMigrated();
    const { workspaceId, workerId, loopId, turnId, engine } = await seed(db);
    try {
        const ids = { workspaceId, workerId, loopId, turnId };
        const first = await dispatchSearch(engine, ids, "capital of france", 1);
        assert.ok(first.status < 400, `the first search dispatches clean; got ${first.status}`);
        await settle(db, workspaceId);  // the stream's 200 conclusion promotes the pending registration
        // the stub wrote #results synchronously; the duplicate serves from the entry
        const dup = await dispatchSearch(engine, ids, "capital of france", 2);
        assert.equal(dup.status, 409, "the duplicate is a strike (409 — the rail counts it)");
        assert.deepEqual(dup.results, DIGEST, "…and SERVES the same results, verbatim, no prose");
        // the model-facing record: the 409 row exists with the results in its rx
        const struck = await db.test_count_op.get<{ n: number }>({ op: "EXEC" });
        assert.ok((struck?.n ?? 0) >= 2, "both EXEC attempts are on the log — the duplicate is recorded, never erased");
    } finally {
        try { await settle(db, workspaceId); } finally { await db.close(); }
    }
});

test("{§search-gate}: the per-turn cap rejects the overflow search", async () => {
    const db = await openMigrated();
    // cap knob ships =3 (.env.defaults floor, loaded by the test cascade)
    const { workspaceId, workerId, loopId, turnId, engine } = await seed(db);
    try {
        const ids = { workspaceId, workerId, loopId, turnId };
        assert.ok((await dispatchSearch(engine, ids, "q1", 1)).status < 400);
        assert.ok((await dispatchSearch(engine, ids, "q2", 2)).status < 400);
        assert.ok((await dispatchSearch(engine, ids, "q3", 3)).status < 400);
        const fourth = await dispatchSearch(engine, ids, "q4", 4);
        assert.equal(fourth.status, 429, "the fourth DISTINCT search this turn is flood-controlled");
        assert.equal(fourth.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/search-limit-reached");
        assert.equal(fourth.problem?.searchLimit, 3);
        assert.equal(fourth.problem?.recovery, "Continue without another search in this turn.");
        assert.equal(fourth.problem?.retryable, false);
    } finally {
        try { await settle(db, workspaceId); } finally { await db.close(); }
    }
});

test("{§search-gate}: a failed search does not poison its retry", async () => {
    const db = await openMigrated();
    const { workspaceId, workerId, loopId, turnId, engine } = await seed(db, { fail: true });
    try {
        const ids = { workspaceId, workerId, loopId, turnId };
        // Spawns are async: dispatch ACCEPTS (200) before run() fails; the failure arrives at
        // the stream's close, where settle() drops the pending registration.
        const accepted = await dispatchSearch(engine, ids, "flaky query", 1);
        assert.ok(accepted.status < 400, `the spawn is accepted at dispatch; got ${accepted.status}`);
        // Once the failed close settles, the retry must NOT be served a dead duplicate.
        await settle(db, workspaceId);
        const retry = await dispatchSearch(engine, ids, "flaky query", 2);
        assert.notEqual(retry.status, 409, "no dedup hit off a failed spawn — the retry dispatches for real");
    } finally {
        try { await settle(db, workspaceId); } finally { await db.close(); }
    }
});
