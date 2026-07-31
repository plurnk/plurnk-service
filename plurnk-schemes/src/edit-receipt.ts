import type { SchemeResult } from "./Results.ts";

export type EditReceiptUnit = "lines" | "codePoints";

export interface EditEffectReceipt {
    readonly requested: string;
    readonly source: string;
    readonly result: string;
    readonly removed: number;
    readonly inserted: number;
    readonly context: string;
}

export interface EditBatchReceipt {
    readonly revision: string;
    readonly unit: EditReceiptUnit;
    readonly before: number;
    readonly after: number;
    readonly effects: readonly EditEffectReceipt[];
}

export interface EditReceipt {
    readonly revision: string;
    readonly unit: EditReceiptUnit;
    readonly before: number;
    readonly after: number;
    readonly effect: EditEffectReceipt;
}

export interface EditBatchResult extends SchemeResult {
    readonly editReceipt?: EditBatchReceipt | null;
}
