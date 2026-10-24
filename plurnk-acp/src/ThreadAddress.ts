import { WORKER_NAME } from "@plurnk/plurnk-contracts";
import { HttpProblemError } from "./action-results.ts";
import { httpProblem } from "./run-events.ts";

/** {§acp-thread-address} Qualified identity is syntax, never a database-existence heuristic. */
export default class ThreadAddress {
    static parse(threadId: string): { workspaceId: number; workerName: string } | null {
        const match = /^([0-9]+)#(.*)$/su.exec(threadId);
        if (match === null) return null;
        const workspaceId = Number(match[1]);
        const workerName = match[2];
        if (String(workspaceId) !== match[1] || !Number.isSafeInteger(workspaceId) || workspaceId < 1 || !WORKER_NAME.test(workerName)) {
            throw new HttpProblemError(httpProblem("thread-address-invalid", 400,
                "The qualified thread address is not <workspace ID>#<worker name>.",
                { threadId, stage: "request-validation", retryable: false }));
        }
        return { workspaceId, workerName };
    }
}
