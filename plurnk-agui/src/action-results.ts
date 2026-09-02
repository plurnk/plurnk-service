// Action outcomes and failures the AG-UI module's run and built-in paths both produce.
import { type ActionOutcome } from "./AguiPlus.ts";
import { Problems, Validator, type OperationResult, type ProblemDetails } from "@plurnk/plurnk-contracts";

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

export const problemFromError = (error: unknown): ProblemDetails | null => {
    if (error instanceof HttpProblemError) return error.problem;
    if (typeof error !== "object" || error === null) return null;
    const result = (error as { result?: unknown }).result;
    if (result !== undefined) {
        try {
            return Validator.assertOperationResult(result as OperationResult).problem ?? null;
        } catch {
            return null;
        }
    }
    const problem = (error as { problem?: unknown }).problem;
    if (problem !== undefined) {
        try {
            return Validator.assertProblemDetails(problem as ProblemDetails);
        } catch {
            return null;
        }
    }
    return null;
};
