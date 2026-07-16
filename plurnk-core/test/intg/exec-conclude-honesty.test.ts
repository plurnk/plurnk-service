// Stream-conclude honesty (execs-search#3's service half, found in a dogfood hang): a driver that
// REJECTS must still conclude its stream (uncaught, the subscription sat open forever and the
// floating spawn promise was an unhandled rejection), and a driver that resolves 2xx UNDER ABORT
// must not be believed — the service's own abort knowledge outranks the claim (a reaped run is not
// a success). A stub runtime drives the REAL dispatch path; nothing is mocked below the executor.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import type { WakeWorkerPayload } from "../../src/core/ChannelWrite.ts";
import { execStmt } from "./_dsl.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { waitFor } from "./_rpc.ts";

let wireN = 0;
const wire = async (run: (args: { signal: AbortSignal }) => Promise<{ status: number; exitCode?: number }>) => {
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
            get manifest() { return { name: tag, protocol: `${tag}:`, channels: {}, defaultChannel: "results", category: "action", scope: "worker", writableBy: ["model"], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return {}; },
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

test("a rejecting driver still concludes its stream — 500, driver_crashed, never an open corpse", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId, tag, wakes } = await wire(async () => {
        throw new Error("Invalid URL");
    });
    try {
        const result = await engine.dispatch({ statement: execStmt(tag, "go"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(result.status, 200, `the spawn started; got ${result.status}`);
        const concluded = await waitFor(() => wakes, (w) => w.length > 0, { timeoutMs: 4000 });
        assert.equal(concluded[0].closeStatus, 500, "the rejected run concluded as a FAILURE, not an open subscription");
        assert.match(concluded[0].summary, /driver_crashed: Invalid URL/, "the summary names the crash, not a synthetic success");
    } finally { await db.close(); }
});

test("a driver resolving 200 under abort is restamped 499 reaped — the service's abort outranks the claim", async () => {
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag, wakes } = await wire((args) => new Promise((res) => {
        // The 0.3.3-class liar: hangs until aborted, then claims success.
        args.signal.addEventListener("abort", () => res({ status: 200, exitCode: 0 }), { once: true });
    }));
    try {
        const result = await engine.dispatch({ statement: execStmt(tag, "go"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(result.status, 200, `the spawn started; got ${result.status}`);
        const sub = await (db.test_open_subscription_for_run as import("../../src/core/Db.ts").PrepMethod).get<{ id: number }>({ worker_id: workerId });
        assert.ok(sub !== undefined, "the spawn's subscription is open");
        (schemes.get("exec") as Exec).abortSubscription(sub.id);
        const concluded = await waitFor(() => wakes.filter((w) => w.closeStatus !== undefined), (w) => w.length > 0, { timeoutMs: 4000 });
        assert.equal(concluded[0].closeStatus, 499, "the reaped run concluded 499, not the driver's claimed 200");
        assert.match(concluded[0].summary, /reaped/, "the summary says reaped — no synthetic 'completed (exit -1)' success");
    } finally { await db.close(); }
});
