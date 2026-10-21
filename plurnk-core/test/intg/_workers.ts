// Integration harness: the model worker a test names. The first call creates it ({§methods-worker-create});
// every later call with that name reads the same worker, as a client's thread does ({§agui-thread-binding}).
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { Db } from "../../src/core/Db.ts";
import type { DispatchResult } from "../../src/core/Dispatcher.ts";
import type Daemon from "../../src/server/Daemon.ts";
import type { TestContext } from "node:test";
import LoopDocs from "../../src/server/loopDocs.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import { insertLoop, insertTurn } from "./_db.ts";

export const namedModelWorker = async (
    daemon: Pick<ApplicationPort, "readWorker" | "createWorker">,
    workspaceId: number,
    name: string,
): Promise<number> => {
    const worker = await daemon.readWorker({ workspaceId, identity: { name } });
    return worker?.origin === "model" ? worker.id : (await daemon.createWorker({ workspaceId, name })).workerId;
};

// One operation of a model worker, without a provider: the demand and the reference reconciliation a loop makes
// before inference ({§methods-workspace-activate}), then one model turn in a loop of the worker's own, dispatched
// with the model's writer tier, so the operation sees that worker's environment, policy, and log
// ({§machine-processes}). A person's operation is `dispatchClientAction` instead ({§connection-lifecycle}).
// The loop concludes when the operation settles.
export const modelOperation = async (
    daemon: Pick<Daemon, "activateWorkspace" | "engine">,
    db: Db,
    { workspaceId, workerId, statement }: { readonly workspaceId: number; readonly workerId: number; readonly statement: PlurnkStatement },
): Promise<DispatchResult> => {
    await daemon.activateWorkspace({ workspaceId });
    await LoopDocs.materialize(daemon.engine, db, workspaceId);
    const loops = await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: workerId });
    const loopId = await insertLoop(db, workerId, (loops?.n ?? 0) + 1, "");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const result = await daemon.engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
    await db.test_set_loop_status.run({ id: loopId, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
    return result;
};

// {§worker-message-admission} Admissions that each open a loop of their own: the worker's drain claims none of them until
// every one is admitted, since an unaddressed arrival joins a loop already running. Later claims pass straight through.
export const admitTogether = async <T>(t: TestContext, workerId: number, admissions: ReadonlyArray<() => Promise<T>>): Promise<T[]> => {
    const admitted = Promise.withResolvers<void>();
    const ensureDrain = DrainSupervisor.prototype.ensureDrain;
    let starts = 0;
    t.mock.method(DrainSupervisor.prototype, "ensureDrain", async function (this: DrainSupervisor, ...args: Parameters<typeof ensureDrain>) {
        if (args[0].workerId === workerId) {
            if (++starts === admissions.length) admitted.resolve();
            await admitted.promise;
        }
        return ensureDrain.apply(this, args);
    });
    return Promise.all(admissions.map((admit) => admit()));
};
