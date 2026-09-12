import type { MatcherBody } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, type MatchEvidence } from "@plurnk/plurnk-schemes";
import Matcher from "../content/matcher.ts";
import MutationEffects from "./MutationEffects.ts";
import PatternEdits from "../content/pattern-edits.ts";
import Results from "./results.ts";
import type { DispatchResult } from "./mutation-types.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";

export type PatternOperation = "EDIT" | "KILL" | "COPY" | "MOVE";

export type PatternBounds = { readonly from: number; readonly to: number } | null;

// {§edit-pattern} {§kill-pattern} {§copy-move-pattern} — the half of a pattern operation that
// every mutation shares once the resource's text is in hand: which dialects can name text, the
// match itself, and the numeric scope that bounds the lines the evidence may touch.
export default class PatternSelection {
    static refuse(code: string, status: number, detail: string, scheme: string, operation: PatternOperation): DispatchResult {
        return MutationEffects.failure(code, status, detail, {}, { scheme, operation, retryable: false });
    }

    // A resource-selecting dialect never names text inside one resource.
    static refuseDialect(matcher: MatcherBody, scheme: string, operation: PatternOperation): DispatchResult | null {
        if (matcher.dialect === "fts" || matcher.dialect === "graph") {
            return PatternSelection.refuse("pattern-dialect-unsupported", 400, `${operation} takes a text pattern; a ${matcher.dialect === "fts" ? "~full-text" : "&graph"} pattern selects resources through FIND.`, scheme, operation);
        }
        return null;
    }

    // Match the content the operation already holds; the numeric scope bounds the evidence.
    static async match({ matcher, content, mimetype, marks, ctx, scheme, operation }: {
        matcher: MatcherBody;
        content: string;
        mimetype: string;
        marks: ReadonlyArray<number | string> | undefined;
        ctx: PlurnkSchemeContext;
        scheme: string;
        operation: PatternOperation;
    }): Promise<{ evidence: readonly MatchEvidence[]; bounds: PatternBounds } | { result: DispatchResult }> {
        if (ctx.mimetypes === undefined) throw new Error("a pattern operation requires the mimetypes capability");
        const match = await Matcher.matchAgainstContent(PatternEdits.lineLimited(matcher), content, mimetype, ctx.mimetypes);
        if (match.status >= 400 || match.status === 203) {
            return { result: match.problem === undefined
                ? PatternSelection.refuse("pattern-unapplicable", 422, match.reason ?? "The pattern could not be applied to the resource.", scheme, operation)
                : Results.assert({ status: match.status >= 400 ? match.status : 422, problem: match.problem }) };
        }
        const lineCount = content.length === 0 ? 0 : content.split("\n").length;
        const numeric = marks?.map((mark) => {
            if (typeof mark !== "number") throw new InvalidOperationResultError("A pattern operation's scope must be numeric after anchor resolution.");
            return mark;
        });
        const bounds = PatternEdits.bounds(numeric, lineCount);
        if (bounds !== null && "error" in bounds) return { result: PatternSelection.refuse("pattern-scope-invalid", 400, bounds.error, scheme, operation) };
        return { evidence: match.matches ?? [], bounds };
    }
}
