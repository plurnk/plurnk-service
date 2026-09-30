// {§skills-functionality} — the skills family's Problems, raised by the adapter and by its sources.
import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";

export class SkillsActionError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails, cause?: unknown) {
        super(problem.detail, cause === undefined ? undefined : { cause });
        this.name = "SkillsActionError";
        this.problem = problem;
    }
}

const problem = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("skills:functionality", code, status, detail, {
    stage: "skills-functionality",
    retryable: status === 409 || status >= 500,
    ...extensions,
});

export const actionError = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
): SkillsActionError => new SkillsActionError(problem(code, status, detail, extensions), cause);

export const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
