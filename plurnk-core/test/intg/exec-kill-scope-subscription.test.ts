// {§subscriptions} — scoped KILL/OPEN is render-only (changes the log entry projection); it must
// NOT cancel a live stream's subscription. A streaming exec, FOLDed mid-stream,
// keeps emitting and closes on its own exit, never on the scoped KILL.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import Log from "../../src/schemes/Log.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, testExecutors } from "./_helpers.ts";

const execStmt = (runtime: string | null, body: string): ExecStatement => ({
    metadata: null,
    op: "EXEC", annotation: null, delimiter: "", executor: runtime, target: null, lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

test("scoped KILL on a streaming exec's log row keeps the subscription live", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-fold-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "fold keeps stream");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(null, "for i in 4 3 2 1; do echo $i; sleep 0.4; done"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;

        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });

        // Mid-stream: KILL the exec's log row body (log:///1/1/1 <1,-1>) — render-only curation.
        await new Promise((r) => setTimeout(r, 500));
        const scoped = await new Log().kill("/1/1/1", { marks: [1, -1] }, makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, writer: "model" }));
        assert.equal(scoped.status, 200, "a scoped KILL of the exec log row succeeds");

        // The subscription is STILL open — scoped KILL touched body visibility, not the registry.
        const midSub = await db.test_get_subscription_by_entry.get<{ closed_at: string | null }>({ worker_id: workerId, entry_id: entryRow!.id });
        assert.equal(midSub?.closed_at, null, "scoped KILL did not cancel the live subscription");

        // The stream runs to its own completion, closing 200 (never 499 from the scoped KILL).
        await exec.idle();
        const endSub = await db.test_get_subscription_by_entry.get<{ closed_at: string | null; close_status: number | null }>({ worker_id: workerId, entry_id: entryRow!.id });
        assert.ok(endSub?.closed_at, "subscription closes on the spawn's own exit");
        assert.equal(endSub?.close_status, 200, "clean 200 exit, not a 499 cancellation");
    } finally { await db.close(); }
});
