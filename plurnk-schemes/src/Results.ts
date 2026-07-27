import { Validator, type ProblemDetails } from "@plurnk/plurnk-grammar";

export type { ProblemDetails };

export interface SchemeResult {
    readonly status: number;
    readonly problem?: ProblemDetails;
    readonly error?: never;
    readonly [field: string]: unknown;
}

export interface SchemeResultBase extends SchemeResult {
    readonly problem?: ProblemDetails;
}

export interface EntryResult extends SchemeResultBase {
    readonly shape: "entry";
    readonly entryId: number | null;
    readonly channel: string | null;
    readonly content?: string | null;
    readonly mimetype?: string | null;
    readonly startLine?: number | null;
    readonly matches?: number | null;
    readonly reason?: string;
}

export interface ProposalResult extends SchemeResultBase {
    readonly shape: "proposal";
    readonly body?: string;
    readonly attrs?: object;
    readonly diff?: string;
}

export interface PassthroughResult extends SchemeResultBase {
    readonly shape: "passthrough";
    readonly content?: string | null;
    readonly mimetype?: string | null;
    readonly startLine?: number | null;
    readonly matches?: number | null;
    readonly reason?: string;
}

const TYPE_ROOT = "https://problems.plurnk.dev";
const OWNER = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/;
const CODE = /^[a-z][a-z0-9-]*$/;

export class InvalidOperationResultError extends TypeError {}

export default class Results {
    static isEntry(result: SchemeResult): result is EntryResult {
        return "shape" in result && result.shape === "entry";
    }

    static isProposal(result: SchemeResult): result is ProposalResult {
        return "shape" in result && result.shape === "proposal";
    }

    static isPassthrough(result: SchemeResult): result is PassthroughResult {
        return "shape" in result && result.shape === "passthrough";
    }

    static isErrorStatus(status: number): boolean {
        return status >= 400;
    }

    static problem(
        owner: string,
        code: string,
        status: number,
        detail: string,
        extensions: Readonly<Record<string, unknown>> = {},
    ): ProblemDetails {
        if (!OWNER.test(owner)) throw new Error(`problem owner must be a colon-delimited lowercase identifier; got ${JSON.stringify(owner)}`);
        if (!CODE.test(code)) throw new Error(`problem code must be a lowercase kebab-case identifier; got ${JSON.stringify(code)}`);
        const title = code.charAt(0).toUpperCase() + code.slice(1).replaceAll("-", " ");
        const problem: ProblemDetails = {
            ...extensions,
            type: `${TYPE_ROOT}/${owner.replaceAll(":", "/")}/${code}`,
            title,
            status,
            detail,
        };
        Results.assertProblem(problem);
        return problem;
    }

    static failure(
        owner: string,
        code: string,
        status: number,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): SchemeResult {
        return Results.assert({
            ...fields,
            status,
            problem: Results.problem(owner, code, status, detail, extensions),
        });
    }

    static assertProblem(problem: unknown): asserts problem is ProblemDetails {
        const validation = Validator.validateProblemDetails(problem);
        if (!validation.valid) {
            throw new TypeError(`invalid RFC 9457 Problem Details: ${JSON.stringify(validation.errors)}`);
        }
    }

    static assert<T extends SchemeResult>(result: T): T {
        const validation = Validator.validateOperationResult(result);
        if (!validation.valid) {
            throw new InvalidOperationResultError(`invalid operation result: ${JSON.stringify(validation.errors)}`);
        }
        if (result.problem !== undefined && result.problem.status !== result.status) {
            throw new InvalidOperationResultError(`operation result status ${result.status} does not match problem status ${result.problem.status}`);
        }
        return result;
    }

    static attachInstance<T extends SchemeResult>(result: T, instance: string): T {
        if (result.problem === undefined) return Results.assert(result);
        result.problem.instance = instance;
        return Results.assert(result);
    }
}
