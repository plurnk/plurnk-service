// Stream-conclude honesty (execs-search#3's service half, found in a dogfood hang): a driver that
// REJECTS must still conclude its stream (uncaught, the subscription sat open forever and the
// floating spawn promise was an unhandled rejection), and a driver that resolves 2xx UNDER ABORT
// must not be believed — the service's own abort knowledge outranks the claim (a reaped run is not
// a success). A stub runtime drives the REAL dispatch path; nothing is mocked below the executor.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Results from "../../src/core/results.ts";
import type { Executor } from "../../src/core/ExecutorRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import type { WakeWorkerPayload } from "../../src/core/ChannelWrite.ts";
import { execStmt, sendStmt } from "./_dsl.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { waitFor } from "./_rpc.ts";

let wireN = 0;
const wire = async (run: Executor["run"]) => {
    const tag = `honesty${++wireN}`;
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const wakes: WakeWorkerPayload[] = [];
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES, wakeWorkerNotify: (p) => { wakes.push(p); } });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    engine.hotloadRuntime(tag, {
        executor: {
            runtime: tag, glyph: "?",
            get manifest() { return { name: tag, channels: { results: "text/stream" }, defaultChannel: "results", category: "data", scope: "workspace", writableBy: ["plugin"], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "text/stream", defaultState: "active" as const } }; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run,
        },
        glyph: "?", example: "", documentation: "", available: true, detail: undefined,
    } as never);
    const workspaceId = await insertWorkspace(db, `honesty-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "honesty test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag, wakes };
};

test("a rejecting driver still concludes its stream with an exact Problem, never an open corpse", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId, tag, wakes } = await wire(async () => {
        throw new Error("Invalid URL");
    });
    try {
        const result = await engine.dispatch({ statement: execStmt(tag, "go"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(result.status, 200, `the spawn started; got ${result.status}`);
        const concluded = await waitFor(() => wakes, (w) => w.length > 0, { timeoutMs: 4000 });
        assert.equal(concluded[0].result.status, 500, "the rejected run concluded as a FAILURE, not an open subscription");
        assert.equal(concluded[0].result.problem?.type, "https://problems.plurnk.dev/scheme/exec/executor-threw");
        assert.match(concluded[0].summary, /executor threw/, "the summary reflects the structured executor-threw result");
    } finally { await db.close(); }
});

test("a status-only executor failure is replaced by an exact contract-violation Problem", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId, tag, wakes } = await wire(async () => ({
        status: 500,
        exitCode: 1,
    }));
    try {
        const started = await engine.dispatch({
            statement: execStmt(tag, "go"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(started.status, 200);
        const concluded = await waitFor(() => wakes, (events) => events.length > 0, { timeoutMs: 4000 });
        assert.equal(concluded[0].result.status, 500);
        assert.equal(
            concluded[0].result.problem?.type,
            "https://problems.plurnk.dev/scheme/exec/executor-invalid-result",
        );
        assert.equal(concluded[0].result.problem?.stage, "result-validation");
        assert.equal(concluded[0].result.problem?.runtime, tag);
        assert.equal(concluded[0].result.problem?.retryable, false);
    } finally { await db.close(); }
});

test("a driver resolving 200 under abort is replaced by a 499 Problem — service truth outranks the claim", async () => {
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag, wakes } = await wire((args) => new Promise((res) => {
        // The 0.3.3-class liar: hangs until aborted, then claims success.
        args.signal.addEventListener("abort", () => res({ status: 200, exitCode: 0 }), { once: true });
    }));
    try {
        const result = await engine.dispatch({ statement: execStmt(tag, "go"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(result.status, 200, `the spawn started; got ${result.status}`);
        const sub = await db.test_open_subscription_for_run.get<{ id: number }>({ worker_id: workerId });
        assert.ok(sub !== undefined, "the spawn's subscription is open");
        await engine.cancelSubscription(sub.id);
        const concluded = await waitFor(() => wakes.filter((w) => w.result !== undefined), (w) => w.length > 0, { timeoutMs: 4000 });
        assert.equal(concluded[0].result.status, 499, "the reaped run concluded 499, not the driver's claimed 200");
        assert.equal(concluded[0].result.problem?.type, "https://problems.plurnk.dev/scheme/exec/execution-cancelled");
        assert.match(concluded[0].summary, /aborted/, "the summary reflects the structured cancellation result");
    } finally { await db.close(); }
});

for (const specimen of [
    { label: "non-empty success", content: "Alice\n", status: 200 },
    { label: "empty success", content: "", status: 200 },
    { label: "non-empty failure", content: "driver failed\n", status: 500 },
    { label: "empty failure", content: "", status: 500 },
] as const) {
    test(`a completed but unobserved ${specimen.label} keeps a same-turn wait alive for its next-packet terminal observation`, async () => {
        const { db, engine, workspaceId, workerId, loopId, turnId, tag, wakes } = await wire(async (args) => {
            if (specimen.content !== "") args.write("results", specimen.content);
            return specimen.status === 200
                ? { status: 200, exitCode: 0 }
                : Results.failure(
                    "executor:honesty",
                    "expected-failure",
                    500,
                    "The executor reported the test failure.",
                    { exitCode: 1 },
                    { runtime: tag, retryable: false },
                );
        });
        try {
            const started = await engine.dispatch({
                statement: execStmt(tag, "go"),
                workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            });
            assert.equal(started.status, 200);
            await waitFor(() => wakes, (events) => events.length > 0, { timeoutMs: 4000 });
            assert.equal(wakes[0].result.status, specimen.status);

            const waited = await engine.dispatch({
                statement: sendStmt(202, null, "waiting"),
                workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model",
            });
            assert.equal(
                waited.status,
                102,
                "closed is not observed: the loop continues so the terminal stream observation can land next packet",
            );
        } finally { await db.close(); }
    });
}
