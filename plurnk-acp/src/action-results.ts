// Action outcomes and failures the ACP module's run and built-in paths both produce.
import { type ActionOutcome } from "./AcpPlus.ts";
import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";

export class HttpProblemError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails) {
        super(problem.detail);
        this.name = "HttpProblemError";
        this.problem = problem;
    }
}

export const actionFailure = (
    code: string,
    detail: string,
    status: number = 400,
    extensions: Readonly<Record<string, unknown>> = {},
): ActionOutcome => ({
    ok: false,
    problem: Problems.create("acp:action", code, status, detail, {
        stage: status < 500 ? "action-validation" : "action-execution",
        retryable: false,
        ...extensions,
    }),
});
