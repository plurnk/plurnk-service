// Integration harness: the model worker a test names. The first call creates it ({§methods-worker-create});
// every later call with that name reads the same worker, as a client's thread does ({§agui-thread-binding}).
import type { ApplicationPort } from "@plurnk/plurnk-contracts";

export const namedModelWorker = async (
    daemon: Pick<ApplicationPort, "readWorker" | "createWorker">,
    workspaceId: number,
    name: string,
): Promise<number> => {
    const worker = await daemon.readWorker({ workspaceId, identity: { name } });
    return worker?.origin === "model" ? worker.id : (await daemon.createWorker({ workspaceId, name })).workerId;
};
