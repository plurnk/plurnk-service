import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import type { RangeExtent } from "@plurnk/plurnk-contracts";
import Results from "./results.ts";
import type { DispatchResult } from "./Dispatcher.ts";

// {§context-fit} — the tokens left in this turn's packet for one more result, measured now: the
// budget less the packet as it would render with every row landed so far, or null without a budget
// ({§tokenomics-window-unpollable-deliberate}).
export interface ContextFit {
    remaining(): Promise<number | null>;
}

// {§context-fit} — the room a turn still owes before one more result may land whole: one receipt's
// measured weight for each result still to land in the same turn, and the head of the emission that
// answers the packet. A bodiless receipt row is a heading, a status, a Problem type and detail, a
// size and a path: as the log renders one it weighs under 160, and that is the reserve. It sizes no
// result; it only decides where in a batch the room runs out, so the receipts of the rest and the
// answer always fit.
export const RECEIPT_RESERVE = 160;

export const reserved = (fit: ContextFit, pending: number): ContextFit => pending <= 0 ? fit : {
    remaining: async () => {
        const remaining = await fit.remaining();
        return remaining === null ? null : Math.max(0, remaining - pending * RECEIPT_RESERVE);
    },
};

export interface ResultSize {
    readonly unit: RangeExtent["unit"];
    readonly total: number;
}

// The size of a result in its projection's own units: the span its range returned when it carries one
// — a scoped READ's receipt names the lines the scope selected, not the resource's — the whole range
// otherwise, its lines without one.
export const resultSize = (result: { readonly range?: RangeExtent; readonly content?: unknown }): ResultSize => {
    const { range } = result;
    if (range !== undefined) return { unit: range.unit, total: range.returned === undefined ? range.total : range.returned[1] - range.returned[0] + 1 };
    return { unit: "line", total: typeof result.content === "string" ? TextCoordinates.logicalLines(result.content).length : 0 };
};

// {§context-fit} — a result the model asked for that does not fit: a `413` receipt naming the result's
// size, its tokens, the remaining budget, the units it delivered above the receipt, and the two verbs.
// The complete result stays where it was read from.
export const RESULT_EXCEEDS_BUDGET = "https://problems.plurnk.xyz/engine/context/result-exceeds-budget";

export const unfitResult = (
    fields: Readonly<Record<string, unknown>>,
    size: ResultSize,
    tokens: number,
    remaining: number,
    verb: "READ" | "FIND" = "READ",
    delivered = 0,
): DispatchResult => Results.failure(
    "engine:context",
    "result-exceeds-budget",
    413,
    `${size.total} ${size.unit}${size.total === 1 ? "" : "s"}, ${tokens} tokens; ${remaining} tokens remain: `
        + `${delivered > 0 ? `${delivered} ${size.unit}${delivered === 1 ? "" : "s"} delivered; ` : ""}`
        + `${verb === "FIND" ? "FIND with a scope" : "READ a range"}, or KILL first.`,
    fields,
    { [`${size.unit}s`]: size.total, tokens, remaining, ...(delivered > 0 ? { delivered } : {}) },
);

// {§context-fit} — the first `count` lines of a READ result as a result of its own: the content cut at
// the line boundary, the per-line anchors and source ordinals cut with it, and the returned range closed
// on the last line delivered. The rest of the result is what the receipt names.
export const resultPrefix = <T extends { readonly content: string }>(result: T, count: number): T => {
    const lines = TextCoordinates.logicalLines(result.content);
    const last = lines[count - 1];
    if (count < 1 || last === undefined) throw new RangeError(`resultPrefix: ${count} of ${lines.length} lines`);
    const view = result as T & { readonly lineAnchors?: readonly string[]; readonly lineOrdinals?: readonly number[]; readonly range?: RangeExtent };
    const ordinals = view.lineOrdinals?.slice(0, count);
    const returned = view.range?.returned;
    return {
        ...result,
        content: result.content.slice(0, last.end),
        ...(view.lineAnchors === undefined ? {} : { lineAnchors: view.lineAnchors.slice(0, count) }),
        ...(ordinals === undefined ? {} : { lineOrdinals: ordinals }),
        ...(view.range === undefined || returned === undefined
            ? {}
            : { range: { ...view.range, returned: [returned[0], ordinals === undefined ? returned[0] + count - 1 : ordinals[count - 1]!] as [number, number] } }),
    };
};

// {§context-fit} — the receipt is an outcome, never a broken program: an internal turn that fails on
// operation errors lets it stand.
export const isContextReceipt = (result: { readonly problem?: { readonly type?: unknown } }): boolean =>
    result.problem?.type === RESULT_EXCEEDS_BUDGET;
