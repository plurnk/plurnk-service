import type { SchemeResult } from "./Results.ts";

export type EditReceiptUnit = "lines" | "codePoints";

export interface ParseIssueTransition {
    readonly before: number;
    readonly after: number;
}

export interface EditEffectReceipt {
    readonly requested: string;
    readonly source: string;
    readonly result: string;
    readonly removed: number;
    readonly inserted: number;
    readonly context: string;
}

interface EditReceiptHead {
    readonly revision: string;
    readonly unit: EditReceiptUnit;
    readonly before: number;
    readonly after: number;
    readonly parseIssues?: ParseIssueTransition;
}

export interface AppliedEditBatchReceipt extends EditReceiptHead {
    readonly effects: readonly EditEffectReceipt[];
}

export interface ReviewerReplacementEditBatchReceipt extends EditReceiptHead {
    readonly disposition: "reviewer-replaced";
    readonly superseded: readonly string[];
    readonly replacement: EditEffectReceipt;
}

export type EditBatchReceipt =
    | AppliedEditBatchReceipt
    | ReviewerReplacementEditBatchReceipt;

export interface AppliedEditReceipt extends EditReceiptHead {
    readonly effect: EditEffectReceipt;
}

export interface SupersededEditReceipt extends EditReceiptHead {
    readonly disposition: "superseded";
    readonly requested: string;
    readonly replacement?: EditEffectReceipt;
}

export type EditReceipt = AppliedEditReceipt | SupersededEditReceipt;

export interface EditBatchResult extends SchemeResult {
    readonly editReceipt?: EditBatchReceipt | null;
}
