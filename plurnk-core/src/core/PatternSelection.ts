import type { MatcherBody, ParsedPath, TextRegion } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError } from "@plurnk/plurnk-schemes";
import Matcher from "../content/matcher.ts";
import MutationEffects from "./MutationEffects.ts";
import PatternEdits from "../content/pattern-edits.ts";
import Results from "./results.ts";
import type { DispatchResult } from "./mutation-types.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";

export type PatternOperation = "EDIT" | "KILL" | "COPY" | "MOVE" | "SEND";

// {§edit-pattern} {§kill-pattern} {§copy-move-pattern} — the half of a pattern operation that
// every mutation shares once the resource's text is in hand: the match itself and
// the source scope that admits complete match regions.
export default class PatternSelection {
    static refuse(code: string, status: number, detail: string, scheme: string, operation: PatternOperation): DispatchResult {
        return MutationEffects.failure(code, status, detail, {}, { scheme, operation, retryable: false });
    }

    // Match the content the operation already holds; the numeric scope bounds the evidence.
    static async match({ matcher, content, mimetype, target, visibleLines, marks, ctx, scheme, operation }: {
        matcher: MatcherBody;
        content: string;
        mimetype: string;
        target: ParsedPath;
        visibleLines?: readonly number[];
        marks: ReadonlyArray<number | string> | undefined;
        ctx: PlurnkSchemeContext;
        scheme: string;
        operation: PatternOperation;
    }): Promise<{ spans: readonly TextRegion[] } | { result: DispatchResult }> {
        if (ctx.mimetypes === undefined) throw new Error("a pattern operation requires the mimetypes capability");
        const match = await Matcher.matchResource(matcher, { content, mimetype, target, ...(visibleLines === undefined ? {} : { visibleLines }) }, ctx);
        if (match.status >= 400 || match.status === 203) {
            return { result: match.problem === undefined
                ? PatternSelection.refuse("pattern-unapplicable", 422, match.reason ?? "The pattern could not be applied to the resource.", scheme, operation)
                : Results.assert({ status: match.status >= 400 ? match.status : 422, problem: match.problem }) };
        }
        const numeric = marks?.map((mark) => {
            if (typeof mark !== "number") throw new InvalidOperationResultError("A pattern operation's scope must be numeric after anchor resolution.");
            return mark;
        });
        const bounds = PatternEdits.bounds(numeric, content);
        if (bounds !== null && "error" in bounds) return { result: PatternSelection.refuse("pattern-scope-invalid", 400, bounds.error, scheme, operation) };
        if (match.matches?.some(({ region }) => region === undefined)) {
            return { result: PatternSelection.refuse("pattern-source-unlocated", 422,
                "The pattern selected a value without exact source coordinates.", scheme, operation) };
        }
        return { spans: PatternEdits.spans(match.matches ?? [], bounds) };
    }
}
