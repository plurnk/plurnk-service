// Action outcomes and failures the AG-UI module's run and built-in paths both produce.
import { type ActionOutcome } from "./AguiPlus.ts";
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
    problem: Problems.create("agui:action", code, status, detail, {
        stage: status < 500 ? "action-validation" : "action-execution",
        retryable: false,
        ...extensions,
    }),
});
