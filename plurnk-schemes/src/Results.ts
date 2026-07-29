import {
    InvalidOperationResultError,
    Problems,
    Validator,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";

export type { ProblemDetails };
export { InvalidOperationResultError };

export interface SchemeResult {
    readonly status: number;
    readonly problem?: ProblemDetails;
    readonly error?: never;
    readonly [field: string]: unknown;
}

export interface SchemeResultBase extends SchemeResult {
    readonly problem?: ProblemDetails;
}

// A matcher location in both the source representation and the readable-row
// representation accepted by READ scope. `path` is the optional canonical
// coordinate supplied by structural dialects such as JSONPath and XPath.
export interface MatchRange {
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly rowStart: number;
    readonly rowEnd: number;
    readonly path?: string;
}

export interface EntryResult extends SchemeResultBase {
    readonly shape: "entry";
    readonly entryId: number | null;
    readonly channel: string | null;
    readonly content?: string | null;
    readonly mimetype?: string | null;
    readonly startLine?: number | null;
    readonly matches?: ReadonlyArray<MatchRange>;
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
    readonly matches?: ReadonlyArray<MatchRange>;
    readonly reason?: string;
}

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
        return Problems.create(owner, code, status, detail, extensions);
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
        Validator.assertProblemDetails(problem as ProblemDetails);
    }

    static assert<T extends SchemeResult>(result: T): T {
        return Validator.assertOperationResult(result);
    }

    static attachInstance<T extends SchemeResult>(result: T, instance: string): T {
        if (result.problem === undefined) return Results.assert(result);
        result.problem.instance = instance;
        return Results.assert(result);
    }
}
