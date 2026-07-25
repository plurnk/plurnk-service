import { createHash } from "node:crypto";
import type { LineMarker } from "@plurnk/plurnk-grammar";

export interface ReceiptEdit {
    readonly marker: LineMarker;
    readonly body: string;
}

interface ReceiptOptions {
    readonly unit?: "lines" | "items";
}

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
    readonly unit: "lines" | "items";
    readonly before: number;
    readonly after: number;
    readonly effects: readonly EditEffectReceipt[];
}

export interface EditReceipt {
    readonly revision: string;
    readonly unit: "lines" | "items";
    readonly before: number;
    readonly after: number;
    readonly effect: EditEffectReceipt;
}

export const editReceiptUnit = (
    structuralJson: boolean,
    original: string,
    updated: string,
): "lines" | "items" => {
    if (!structuralJson) return "lines";
    try {
        if (original.length > 0) JSON.parse(original);
        if (updated.length > 0) JSON.parse(updated);
        return "items";
    } catch {
        return "lines";
    }
};

export const projectEditReceipt = (receipt: EditBatchReceipt, index: number): EditReceipt => {
    const effect = receipt.effects[index];
    if (effect === undefined) throw new Error(`EDIT receipt has no effect at index ${index}`);
    return {
        revision: receipt.revision,
        unit: receipt.unit,
        before: receipt.before,
        after: receipt.after,
        effect,
    };
};

const splitLines = (content: string): string[] => {
    if (content.length === 0) return [];
    const lines = content.split("\n");
    if (content.endsWith("\n")) lines.pop();
    return lines;
};

const markerText = ({ marks }: LineMarker): string => `<${marks.join(",")}>`;

const sourceRange = (marker: LineMarker, total: number): { start: number; end: number; removed: number } => {
    const first = marker.marks[0];
    const last = marker.marks[1];
    if (last !== undefined) {
        const start = first === 0 ? 1 : first;
        const end = last === -1 ? total : last;
        return { start, end, removed: Math.max(0, end - start + 1) };
    }
    if (first === 0) return { start: 1, end: 0, removed: 0 };
    if (first === -1) return { start: total + 1, end: total, removed: 0 };
    if (!Number.isInteger(first)) {
        const start = Math.floor(first) + 1;
        return { start, end: start - 1, removed: 0 };
    }
    return { start: first, end: first, removed: 1 };
};

export const editReceipt = (
    original: string,
    updated: string,
    edits: readonly ReceiptEdit[],
    options: ReceiptOptions = {},
): EditBatchReceipt => {
    const { unit = "lines" } = options;
    const before = splitLines(original);
    const after = splitLines(updated);
    let sourceShape: "array" | "object" | "scalar" = "scalar";
    const itemCount = (content: string): number => {
        if (content.length === 0) return 0;
        const parsed = JSON.parse(content) as unknown;
        if (Array.isArray(parsed)) return parsed.length;
        if (parsed !== null && typeof parsed === "object") return Object.keys(parsed).length;
        return 1;
    };
    if (unit === "items" && (original.length > 0 || updated.length > 0)) {
        const parsed = JSON.parse(original.length > 0 ? original : updated) as unknown;
        sourceShape = Array.isArray(parsed) ? "array" : parsed !== null && typeof parsed === "object" ? "object" : "scalar";
    }
    const countBody = (body: string): number => {
        if (unit === "lines") return splitLines(body).length;
        if (body.length === 0) return 0;
        const parsed = JSON.parse(body) as unknown;
        if (sourceShape === "array") return Array.isArray(parsed) ? parsed.length : 1;
        if (sourceShape === "object") {
            const values = Array.isArray(parsed) ? parsed : [parsed];
            return values.reduce((count, value) =>
                count + (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0), 0);
        }
        return Array.isArray(parsed) ? parsed.length : 1;
    };
    const beforeExtent = unit === "lines" ? before.length : itemCount(original);
    const afterExtent = unit === "lines" ? after.length : itemCount(updated);
    let offset = 0;
    const effectsByIndex: Array<{
        marker: string;
        source: { start: number; end: number; removed: number };
        inserted: number;
        resultStart: number;
        resultEnd: number;
    } | undefined> = new Array(edits.length);
    edits
        .map((edit, index) => ({ edit, index, source: sourceRange(edit.marker, beforeExtent) }))
        .sort((a, b) => a.source.start - b.source.start)
        .forEach(({ edit, index, source }) => {
            const inserted = countBody(edit.body);
            const resultStart = source.start + offset;
            const resultEnd = inserted === 0 ? resultStart - 1 : resultStart + inserted - 1;
            offset += inserted - source.removed;
            effectsByIndex[index] = {
                marker: markerText(edit.marker),
                source,
                inserted,
                resultStart,
                resultEnd,
            };
        });
    const effects = effectsByIndex.map((effect, index) => {
        if (effect === undefined) throw new Error(`EDIT receipt calculation omitted effect ${index}`);
        return effect;
    });

    const joinRadiusRaw = process.env.PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES;
    const joinRadius = Number(joinRadiusRaw);
    if (!Number.isSafeInteger(joinRadius) || joinRadius < 0) {
        throw new Error(`PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES must be a non-negative safe integer, got ${JSON.stringify(joinRadiusRaw)}`);
    }
    const contextItems = unit === "lines"
        ? after
        : (() => {
            if (updated.length === 0) return [];
            const parsed = JSON.parse(updated) as unknown;
            if (Array.isArray(parsed)) return parsed.map((item) => JSON.stringify(item));
            if (parsed !== null && typeof parsed === "object") return Object.entries(parsed).map(([key, value]) => JSON.stringify({ [key]: value }));
            return [JSON.stringify(parsed)];
        })();
    const withContext = effects.map((effect) => {
        const visible = new Set<number>();
        const join = Math.min(Math.max(effect.resultStart, 1), Math.max(contextItems.length, 1));
        const end = Math.max(join, effect.resultEnd);
        for (let line = Math.max(1, join - joinRadius); line <= Math.min(contextItems.length, end + joinRadius); line += 1) {
            visible.add(line);
        }
        const contextRows = [...visible].sort((a, b) => a - b).map((line) => `${line}:${contextItems[line - 1]}`);
        const sourceText = effect.source.removed === 0 ? `${effect.source.start}^` : effect.source.start === effect.source.end ? `${effect.source.start}` : `${effect.source.start}-${effect.source.end}`;
        const resultText = effect.resultEnd < effect.resultStart ? `${effect.resultStart}^` : effect.resultStart === effect.resultEnd ? `${effect.resultStart}` : `${effect.resultStart}-${effect.resultEnd}`;
        return {
            requested: effect.marker,
            source: sourceText,
            result: resultText,
            removed: effect.source.removed,
            inserted: effect.inserted,
            context: contextRows.join("\n"),
        };
    });

    const revision = createHash("sha256").update(updated).digest("hex");
    return {
        revision,
        unit,
        before: beforeExtent,
        after: afterExtent,
        effects: withContext,
    };
};
