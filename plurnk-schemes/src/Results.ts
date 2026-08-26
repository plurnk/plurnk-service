import {
    InvalidOperationResultError,
    Problems,
    Validator,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { TextRegion } from "@plurnk/plurnk-contracts";

export type { ProblemDetails };
export { InvalidOperationResultError };

export interface ScopeNormalization {
    readonly requested: readonly [number, number, number];
    readonly canonical: readonly [number, number, number, number];
}

export interface SchemeResult {
    readonly status: number;
    readonly problem?: ProblemDetails;
    readonly scopeNormalizations?: ReadonlyArray<ScopeNormalization>;
    readonly error?: never;
    readonly [field: string]: unknown;
}

export interface SchemeResultBase extends SchemeResult {
    readonly problem?: ProblemDetails;
}

// Exact terminal evidence about one produced channel. Core-owned selection and
// projection fields are structurally unavailable: the consumer adds those only
// after it selects this channel and projects the authored text scope.
export interface ChannelProducerResult extends SchemeResultBase {
    readonly content?: never;
    readonly mimetype?: never;
    readonly channel?: never;
    readonly startLine?: never;
    readonly lineAnchorIdentity?: never;
    readonly lineAnchors?: never;
    readonly region?: never;
    readonly matches?: never;
    readonly range?: never;
}

// A scope- and channel-neutral preparation result. `status: 200` means the
// complete representation, including channel producer results, is ready in the
// canonical entry. `102` means it remains genuinely live; other statuses are
// returned directly.
export interface RepresentationPreparationResult extends SchemeResultBase {}

// Evidence explaining why a matcher selected a resource. Structural dialects
// retain their canonical `locator`. `region` is present only when the
// finding has an honest exact or enclosing mapping into text the model can READ.
export interface MatchEvidence {
    readonly locator?: string;
    readonly region?: TextRegion;
    // The matched text itself (regex and glob dialects): a match row reads without a READ.
    readonly matched?: string;
    // The entry channel the match was located in ({§find-result-projection});
    // absent for channel-less resources such as log rows.
    readonly channel?: string;
}

export interface EntryResult extends SchemeResultBase {
    readonly shape: "entry";
    readonly entryId: number | null;
    readonly channel: string | null;
    readonly content?: string | null;
    readonly mimetype?: string | null;
    readonly startLine?: number | null;
    readonly region?: TextRegion;
    readonly matches?: ReadonlyArray<MatchEvidence>;
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
    readonly region?: TextRegion;
    readonly matches?: ReadonlyArray<MatchEvidence>;
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

    static assertMatchEvidence(evidence: unknown): MatchEvidence {
        if (
            evidence === null
            || typeof evidence !== "object"
            || Array.isArray(evidence)
        ) {
            throw new TypeError("invalid match evidence: expected an object");
        }
        const record = evidence as Record<string, unknown>;
        const extras = Object.keys(record).filter((key) => key !== "locator" && key !== "region" && key !== "matched");
        if (extras.length > 0) {
            throw new TypeError(`invalid match evidence: unexpected field ${JSON.stringify(extras[0])}`);
        }
        if (record.matched !== undefined && typeof record.matched !== "string") {
            throw new TypeError("invalid match evidence: matched must be a string");
        }
        const hasLocator = Object.hasOwn(record, "locator");
        const hasRegion = Object.hasOwn(record, "region");
        if (!hasLocator && !hasRegion) {
            throw new TypeError("invalid match evidence: expected locator, region, or both");
        }
        if (hasLocator && (typeof record.locator !== "string" || record.locator.length === 0)) {
            throw new TypeError("invalid match evidence: locator must be a non-empty string");
        }
        if (hasRegion) Validator.assertTextRegion(record.region as TextRegion);
        return evidence as MatchEvidence;
    }

    static assertMatchEvidenceList(evidence: unknown): ReadonlyArray<MatchEvidence> {
        if (!Array.isArray(evidence)) {
            throw new TypeError("invalid match evidence list: expected an array");
        }
        for (const item of evidence) Results.assertMatchEvidence(item);
        return evidence as ReadonlyArray<MatchEvidence>;
    }

    static assertReadResult<T extends SchemeResult>(result: T): T {
        const exact = Results.assert(result);
        const record = exact as Record<string, unknown>;
        if (Object.hasOwn(record, "region") && record.region !== undefined) {
            Validator.assertTextRegion(record.region as TextRegion);
        }
        if (Object.hasOwn(record, "matches") && record.matches !== undefined) {
            Results.assertMatchEvidenceList(record.matches);
        }
        return exact;
    }

    static assertRepresentationPreparation<T extends RepresentationPreparationResult>(result: T): T {
        const exact = Results.assert(result);
        if (exact.status < 200 && exact.status !== 102) {
            throw new InvalidOperationResultError(
                "a live representation preparation must use status 102",
            );
        }
        if (exact.status >= 200 && exact.status < 300 && exact.status !== 200) {
            throw new InvalidOperationResultError(
                "representation preparation readiness must use status 200",
            );
        }
        if (Object.hasOwn(exact, "channelOutcomes")) {
            throw new InvalidOperationResultError(
                "representation preparation cannot carry transient channel outcomes",
            );
        }
        const projectionFields = ["content", "mimetype", "channel", "startLine", "lineAnchorIdentity", "lineAnchors", "lineNumberWidth", "region", "matches", "range"];
        const owned = projectionFields.find((field) => Object.hasOwn(exact, field));
        if (owned !== undefined) {
            throw new InvalidOperationResultError(
                `representation preparation cannot carry core-owned projection field ${JSON.stringify(owned)}`,
            );
        }
        return exact;
    }

    static assertChannelProducerResult<T extends ChannelProducerResult>(result: T): T {
        const exact = Results.assert(result);
        if (exact.status < 200 || exact.status === 202) {
            throw new InvalidOperationResultError(
                `channel producer result cannot use nonterminal status ${exact.status}`,
            );
        }
        const projectionFields = ["content", "mimetype", "channel", "startLine", "lineAnchorIdentity", "lineAnchors", "lineNumberWidth", "region", "matches", "range"];
        const owned = projectionFields.find((field) => Object.hasOwn(exact, field));
        if (owned !== undefined) {
            throw new InvalidOperationResultError(
                `channel producer result cannot carry core-owned projection field ${JSON.stringify(owned)}`,
            );
        }
        return exact;
    }

    static assertScopeNormalizations(value: unknown): ReadonlyArray<ScopeNormalization> {
        if (!Array.isArray(value) || value.length === 0) {
            throw new TypeError("invalid scope normalizations: expected a non-empty array");
        }
        for (const item of value) {
            if (item === null || typeof item !== "object" || Array.isArray(item)) {
                throw new TypeError("invalid scope normalization: expected an object");
            }
            const record = item as Record<string, unknown>;
            const extras = Object.keys(record).filter((key) => key !== "requested" && key !== "canonical");
            if (extras.length > 0) {
                throw new TypeError(`invalid scope normalization: unexpected field ${JSON.stringify(extras[0])}`);
            }
            if (!Object.hasOwn(record, "requested") || !Object.hasOwn(record, "canonical")) {
                throw new TypeError("invalid scope normalization: requested and canonical coordinates are required");
            }
            const { requested, canonical } = record;
            if (
                !Array.isArray(requested)
                || requested.length !== 3
                || !requested.every(Number.isSafeInteger)
            ) {
                throw new TypeError("invalid scope normalization: requested must contain three safe integers");
            }
            if (
                !Array.isArray(canonical)
                || canonical.length !== 4
                || !canonical.every(Number.isSafeInteger)
            ) {
                throw new TypeError("invalid scope normalization: canonical must contain four safe integers");
            }
            if (!requested.every((coordinate, index) => canonical[index] === coordinate)) {
                throw new TypeError("invalid scope normalization: canonical coordinates must preserve the requested prefix");
            }
        }
        return value as ReadonlyArray<ScopeNormalization>;
    }

    static assert<T extends SchemeResult>(result: T): T {
        const exact = Validator.assertOperationResult(result);
        if (exact.scopeNormalizations !== undefined) {
            Results.assertScopeNormalizations(exact.scopeNormalizations);
        }
        return exact;
    }

    static attachInstance<T extends SchemeResult>(result: T, instance: string): T {
        if (result.problem === undefined) return Results.assert(result);
        result.problem.instance = instance;
        return Results.assert(result);
    }
}
