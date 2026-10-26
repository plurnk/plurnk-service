// Integration harness: the model session a test names. The first call creates it ({§methods-session-create});
// every later call with that name reads the same session, as a client's thread does ({§acp-thread-binding}).
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { Db } from "../../src/core/Db.ts";
import type { DispatchResult } from "../../src/core/Dispatcher.ts";
import type Daemon from "../../src/server/Daemon.ts";
import type { TestContext } from "node:test";
import LoopDocs from "../../src/server/loopDocs.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import { insertLoop, insertTurn } from "./_db.ts";

export const namedModelSession = async (
    daemon: Pick<ApplicationPort, "readSession" | "createSession">,
    workspaceId: number,
    name: string,
): Promise<number> => {
    const session = await daemon.readSession({ workspaceId, identity: { name } });
    return session?.origin === "model" ? session.id : (await daemon.createSession({ workspaceId, name })).sessionId;
};

// One operation of a model session, without a provider: the demand and the reference reconciliation a loop makes
// before inference ({§methods-workspace-activate}), then one model turn in a loop of the session's own, dispatched
// with the model's writer tier, so the operation sees that session's environment, policy, and log
// ({§machine-processes}). A person's operation is `dispatchClientAction` instead ({§connection-lifecycle}).
// The loop concludes when the operation settles.
export const modelOperation = async (
    daemon: Pick<Daemon, "activateWorkspace" | "engine">,
    db: Db,
    { workspaceId, sessionId, statement }: { readonly workspaceId: number; readonly sessionId: number; readonly statement: PlurnkStatement },
): Promise<DispatchResult> => {
    await daemon.activateWorkspace({ workspaceId });
    await LoopDocs.materialize(daemon.engine, db, workspaceId);
    const loops = await db.test_count_loops_by_session.get<{ n: number }>({ session_id: sessionId });
    const loopId = await insertLoop(db, sessionId, (loops?.n ?? 0) + 1, "");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const result = await daemon.engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
    await db.test_set_loop_status.run({ id: loopId, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
    return result;
};

// {§session-message-admission} Admissions that each open a loop of their own: the session's drain claims none of them until
// every one is admitted, since an unaddressed arrival joins a loop already running. Later claims pass straight through.
export const admitTogether = async <T>(t: TestContext, sessionId: number, admissions: ReadonlyArray<() => Promise<T>>): Promise<T[]> => {
    const admitted = Promise.withResolvers<void>();
    const ensureDrain = DrainSupervisor.prototype.ensureDrain;
    let starts = 0;
    t.mock.method(DrainSupervisor.prototype, "ensureDrain", async function (this: DrainSupervisor, ...args: Parameters<typeof ensureDrain>) {
        if (args[0].sessionId === sessionId) {
            if (++starts === admissions.length) admitted.resolve();
            await admitted.promise;
        }
        return ensureDrain.apply(this, args);
    });
    return Promise.all(admissions.map((admit) => admit()));
};
