import { Problems, WORKER_NAME, type ProblemDetails } from "@plurnk/plurnk-contracts";

export class HttpProblemError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails) {
        super(problem.detail);
        this.name = "HttpProblemError";
        this.problem = problem;
    }
}

export const acpProblem = (
    code: string,
    status: number,
    detail: string,
    options: Record<string, unknown> = {},
): ProblemDetails => Problems.create("acp", code, status, detail, options);

/** {§acp-session-binding} Qualified session identity is `<workspaceId>#<workerName>`, never a database-existence heuristic. */
export default class SessionAddress {
    static parse(sessionId: string): { workspaceId: number; workerName: string } | null {
        const match = /^([0-9]+)#(.*)$/su.exec(sessionId);
        if (match === null) return null;
        const workspaceId = Number(match[1]);
        const workerName = match[2];
        if (String(workspaceId) !== match[1] || !Number.isSafeInteger(workspaceId) || workspaceId < 1 || !WORKER_NAME.test(workerName)) {
            throw new HttpProblemError(acpProblem(
                "session-address-invalid",
                400,
                "The qualified session address is not <workspace ID>#<worker name>.",
                { sessionId, stage: "request-validation", retryable: false },
            ));
        }
        return { workspaceId, workerName };
    }

    static format(workspaceId: number, workerName: string): string {
        return `${workspaceId}#${workerName}`;
    }
}
