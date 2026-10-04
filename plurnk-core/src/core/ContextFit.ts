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

// {§context-fit} — the room a turn still owes before one more result may land whole: one bodiless
// receipt for each result still to land in the same turn, and the head of the emission that answers
// the packet. A receipt row is a heading, a status, a Problem type and detail, a size and a path;
// this bounds one. It sizes no result; it only decides where in a batch the room runs out, so the
// receipts of the rest and the answer always fit.
export const RECEIPT_RESERVE = 256;

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

// The size of a result in its projection's own units: its range when it carries one, its lines otherwise.
export const resultSize = (result: { readonly range?: RangeExtent; readonly content?: unknown }): ResultSize => {
    if (result.range !== undefined) return { unit: result.range.unit, total: result.range.total };
    return { unit: "line", total: typeof result.content === "string" ? TextCoordinates.logicalLines(result.content).length : 0 };
};

// {§context-fit} — a result the model asked for that does not fit: a bodiless `413` naming the
// result's size, its tokens, the remaining budget, and the two verbs. The complete result stays
// where it was read from; the row carries no body.
export const RESULT_EXCEEDS_BUDGET = "https://problems.plurnk.xyz/engine/context/result-exceeds-budget";

export const unfitResult = (
    fields: Readonly<Record<string, unknown>>,
    size: ResultSize,
    tokens: number,
    remaining: number,
    verb: "READ" | "FIND" = "READ",
): DispatchResult => Results.failure(
    "engine:context",
    "result-exceeds-budget",
    413,
    `${size.total} ${size.unit}${size.total === 1 ? "" : "s"}, ${tokens} tokens; ${remaining} tokens remain: ${verb === "FIND" ? "FIND with a scope" : "READ a range"}, or KILL first.`,
    fields,
    { [`${size.unit}s`]: size.total, tokens, remaining },
);

// {§context-fit} — the receipt is an outcome, never a broken program: an internal turn that fails on
// operation errors lets it stand.
export const isContextReceipt = (result: { readonly problem?: { readonly type?: unknown } }): boolean =>
    result.problem?.type === RESULT_EXCEEDS_BUDGET;
