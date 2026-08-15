import { createHash } from "node:crypto";
import { InvalidOperationResultError } from "@plurnk/plurnk-contracts";
import type { LineMarker } from "@plurnk/plurnk-contracts";
import type {
    AppliedEditBatchReceipt,
    EditBatchReceipt,
    EditEffectReceipt,
    EditReceipt,
    EditReceiptUnit,
    ReviewerReplacementEditBatchReceipt,
} from "@plurnk/plurnk-schemes";
import LineMarkerOps from "./line-marker.ts";

export interface ReceiptEdit {
    readonly marker: LineMarker;
    readonly body: string;
}

export type {
    AppliedEditBatchReceipt,
    EditBatchReceipt,
    EditEffectReceipt,
    EditReceipt,
    EditReceiptUnit,
    ReviewerReplacementEditBatchReceipt,
} from "@plurnk/plurnk-schemes";

export type ResourceEffectAction = "create" | "update" | "delete";

export interface ResourceEffect {
    readonly target: string;
    readonly action: ResourceEffectAction;
    readonly receipt?: EditReceipt;
}

interface EffectWithContextRange extends EditEffectReceipt {
    readonly resultStartLine: number;
    readonly resultEndLine: number;
}

const receiptRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new InvalidOperationResultError(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
};

const exactFields = (
    record: Record<string, unknown>,
    fields: readonly string[],
    label: string,
): void => {
    const allowed = new Set(fields);
    const unexpected = Object.keys(record).find((field) => !allowed.has(field));
    if (unexpected !== undefined) {
        throw new InvalidOperationResultError(
            `${label} contains unexpected field ${JSON.stringify(unexpected)}.`,
        );
    }
    const missing = fields.find((field) => !Object.hasOwn(record, field));
    if (missing !== undefined) {
        throw new InvalidOperationResultError(
            `${label} is missing field ${JSON.stringify(missing)}.`,
        );
    }
};

const assertExtent = (value: unknown, field: string): void => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new InvalidOperationResultError(
            `EDIT receipt ${field} must be a non-negative safe integer.`,
        );
    }
};

const assertEffectReceipt = (value: unknown): EditEffectReceipt => {
    const effect = receiptRecord(value, "EDIT effect receipt");
    exactFields(
        effect,
        ["requested", "source", "result", "removed", "inserted", "context"],
        "EDIT effect receipt",
    );
    for (const field of ["requested", "source", "result", "context"] as const) {
        if (typeof effect[field] !== "string") {
            throw new InvalidOperationResultError(
                `EDIT effect receipt ${field} must be a string.`,
            );
        }
    }
    assertExtent(effect.removed, "removed");
    assertExtent(effect.inserted, "inserted");
    return value as EditEffectReceipt;
};

const assertReceiptHead = (
    receipt: Record<string, unknown>,
    label: string,
): void => {
    if (typeof receipt.revision !== "string" || !/^[a-f0-9]{64}$/.test(receipt.revision)) {
        throw new InvalidOperationResultError(`${label} revision must be a lowercase SHA-256 digest.`);
    }
    if (receipt.unit !== "lines" && receipt.unit !== "codePoints") {
        throw new InvalidOperationResultError(`${label} unit must be 'lines' or 'codePoints'.`);
    }
    assertExtent(receipt.before, "before");
    assertExtent(receipt.after, "after");
};

export const assertEditReceipt = (value: unknown): EditReceipt => {
    const receipt = receiptRecord(value, "EDIT receipt");
    if (receipt.disposition === "superseded") {
        exactFields(
            receipt,
            Object.hasOwn(receipt, "replacement")
                ? ["revision", "unit", "before", "after", "disposition", "requested", "replacement"]
                : ["revision", "unit", "before", "after", "disposition", "requested"],
            "EDIT receipt",
        );
        assertReceiptHead(receipt, "EDIT receipt");
        if (typeof receipt.requested !== "string" || receipt.requested.length === 0) {
            throw new InvalidOperationResultError(
                "A superseded EDIT receipt requested marker must be a non-empty string.",
            );
        }
        if (Object.hasOwn(receipt, "replacement")) assertEffectReceipt(receipt.replacement);
        return value as EditReceipt;
    }
    exactFields(receipt, ["revision", "unit", "before", "after", "effect"], "EDIT receipt");
    assertReceiptHead(receipt, "EDIT receipt");
    assertEffectReceipt(receipt.effect);
    return value as EditReceipt;
};

export const assertEditBatchReceipt = (value: unknown): EditBatchReceipt => {
    const receipt = receiptRecord(value, "EDIT batch receipt");
    if (receipt.disposition === "reviewer-replaced") {
        exactFields(
            receipt,
            ["revision", "unit", "before", "after", "disposition", "superseded", "replacement"],
            "EDIT batch receipt",
        );
        assertReceiptHead(receipt, "EDIT batch receipt");
        if (
            !Array.isArray(receipt.superseded)
            || receipt.superseded.length === 0
            || receipt.superseded.some((requested) => typeof requested !== "string" || requested.length === 0)
        ) {
            throw new InvalidOperationResultError(
                "A reviewer-replaced EDIT batch receipt superseded list must contain non-empty requested markers.",
            );
        }
        assertEffectReceipt(receipt.replacement);
        return value as unknown as EditBatchReceipt;
    }
    exactFields(receipt, ["revision", "unit", "before", "after", "effects"], "EDIT batch receipt");
    assertReceiptHead(receipt, "EDIT batch receipt");
    if (!Array.isArray(receipt.effects) || receipt.effects.length === 0) {
        throw new InvalidOperationResultError("EDIT batch receipt effects must be a non-empty array.");
    }
    for (const effect of receipt.effects) assertEffectReceipt(effect);
    return value as unknown as EditBatchReceipt;
};

export const assertResourceEffects = (value: unknown): readonly ResourceEffect[] => {
    if (!Array.isArray(value) || value.length === 0) {
        throw new InvalidOperationResultError("Resource effects must be a non-empty array.");
    }
    for (const candidate of value) {
        const effect = receiptRecord(candidate, "Resource effect");
        const fields = Object.hasOwn(effect, "receipt")
            ? ["target", "action", "receipt"]
            : ["target", "action"];
        exactFields(effect, fields, "Resource effect");
        if (typeof effect.target !== "string" || effect.target.length === 0) {
            throw new InvalidOperationResultError("Resource effect target must be a non-empty string.");
        }
        if (
            effect.action !== "create"
            && effect.action !== "update"
            && effect.action !== "delete"
        ) {
            throw new InvalidOperationResultError(
                "Resource effect action must be 'create', 'update', or 'delete'.",
            );
        }
        if (Object.hasOwn(effect, "receipt")) {
            if (effect.action === "delete") {
                throw new InvalidOperationResultError(
                    "Only a created or updated resource effect may carry a text receipt.",
                );
            }
            const receipt = assertEditReceipt(effect.receipt);
            if (effect.action === "create" && receipt.before !== 0) {
                throw new InvalidOperationResultError(
                    "A created resource effect receipt must have a before extent of zero.",
                );
            }
        }
    }
    return value as readonly ResourceEffect[];
};

export const projectEditReceipt = (receipt: EditBatchReceipt, index: number): EditReceipt => {
    const exact = assertEditBatchReceipt(receipt);
    if ("disposition" in exact) {
        const requested = exact.superseded[index];
        if (requested === undefined) throw new Error(`EDIT receipt has no superseded request at index ${index}`);
        return {
            revision: exact.revision,
            unit: exact.unit,
            before: exact.before,
            after: exact.after,
            disposition: "superseded",
            requested,
            ...(index === 0 ? { replacement: exact.replacement } : {}),
        };
    }
    const effect = exact.effects[index];
    if (effect === undefined) throw new Error(`EDIT receipt has no effect at index ${index}`);
    return {
        revision: exact.revision,
        unit: exact.unit,
        before: exact.before,
        after: exact.after,
        effect,
    };
};

const splitLines = (content: string): string[] => {
    if (content.length === 0) return [];
    const lines = content.split(/\r\n|\r|\n/);
    if (/[\r\n]$/.test(content)) lines.pop();
    return lines;
};

const markerText = ({ marks }: LineMarker): string => `<${marks.join(",")}>`;

const sourceLineRange = (
    marker: LineMarker,
    total: number,
): { start: number; end: number; removed: number } => {
    const first = marker.marks[0];
    const last = marker.marks[1];
    if (last !== undefined) {
        const start = first === 0 ? 1 : first;
        const end = last === -1 ? total : last;
        return { start, end, removed: Math.max(0, end - start + 1) };
    }
    if (first === 0) return { start: 1, end: 0, removed: 0 };
    if (first === -1) return { start: total + 1, end: total, removed: 0 };
    if (!Number.isInteger(first)) throw new Error("Whole-line EDIT receipts require integer coordinates.");
    return { start: first, end: first, removed: 1 };
};

const lineEffects = (
    original: string,
    edits: readonly ReceiptEdit[],
): EffectWithContextRange[] => {
    const before = splitLines(original);
    let offset = 0;
    const effects: Array<EffectWithContextRange | undefined> = new Array(edits.length);
    edits
        .map((edit, index) => ({
            edit,
            index,
            source: sourceLineRange(edit.marker, before.length),
        }))
        .sort((left, right) => left.source.start - right.source.start)
        .forEach(({ edit, index, source }) => {
            const inserted = splitLines(edit.body).length;
            const resultStart = source.start + offset;
            const resultEnd = inserted === 0
                ? resultStart - 1
                : resultStart + inserted - 1;
            offset += inserted - source.removed;
            effects[index] = {
                requested: markerText(edit.marker),
                source: source.removed === 0
                    ? `${source.start}^`
                    : source.start === source.end
                        ? `${source.start}`
                        : `${source.start}-${source.end}`,
                result: resultEnd < resultStart
                    ? `${resultStart}^`
                    : resultStart === resultEnd
                        ? `${resultStart}`
                        : `${resultStart}-${resultEnd}`,
                removed: source.removed,
                inserted,
                context: "",
                resultStartLine: resultStart,
                resultEndLine: Math.max(resultStart, resultEnd),
            };
        });
    return effects.map((effect, index) => {
        if (effect === undefined) throw new Error(`EDIT receipt calculation omitted effect ${index}`);
        return effect;
    });
};

const codePointCount = (content: string): number => [...content].length;

const codePointOffset = (content: string, jsOffset: number): number =>
    codePointCount(content.slice(0, jsOffset));

const jsOffsetFromCodePoints = (content: string, offset: number): number =>
    [...content].slice(0, offset).join("").length;

const coordinateAt = (
    content: string,
    codePoints: number,
): { line: number; column: number } => {
    const prefix = content.slice(0, jsOffsetFromCodePoints(content, codePoints));
    const lines = prefix.split(/\r\n|\r|\n/);
    return {
        line: lines.length,
        column: codePointCount(lines.at(-1) ?? "") + 1,
    };
};

const coordinateText = ({ line, column }: { line: number; column: number }): string =>
    `${line}:${column}`;

const codePointEffects = (
    original: string,
    updated: string,
    edits: readonly ReceiptEdit[],
): EffectWithContextRange[] => {
    const effects: Array<EffectWithContextRange | undefined> = new Array(edits.length);
    let offset = 0;
    edits
        .map((edit, index) => {
            const replacement = LineMarkerOps.textReplacement(
                original,
                edit.marker,
                edit.body,
            );
            if ("error" in replacement) {
                throw new Error(`EDIT receipt could not resolve ${markerText(edit.marker)}: ${replacement.error}`);
            }
            return {
                edit,
                index,
                replacement,
                sourceStart: codePointOffset(original, replacement.start),
                sourceEnd: codePointOffset(original, replacement.end),
                inserted: codePointCount(replacement.body),
            };
        })
        .sort((left, right) => left.sourceStart - right.sourceStart)
        .forEach((effect) => {
            const removed = effect.sourceEnd - effect.sourceStart;
            const resultStart = effect.sourceStart + offset;
            const resultEnd = resultStart + effect.inserted;
            offset += effect.inserted - removed;
            const sourceStart = coordinateAt(original, effect.sourceStart);
            const sourceEnd = coordinateAt(original, effect.sourceEnd);
            const updatedStart = coordinateAt(updated, resultStart);
            const updatedEnd = coordinateAt(updated, resultEnd);
            effects[effect.index] = {
                requested: markerText(effect.edit.marker),
                source: removed === 0
                    ? `${coordinateText(sourceStart)}^`
                    : `${coordinateText(sourceStart)}-${coordinateText(sourceEnd)}`,
                result: effect.inserted === 0
                    ? `${coordinateText(updatedStart)}^`
                    : `${coordinateText(updatedStart)}-${coordinateText(updatedEnd)}`,
                removed,
                inserted: effect.inserted,
                context: "",
                resultStartLine: updatedStart.line,
                resultEndLine: updatedEnd.line,
            };
        });
    return effects.map((effect, index) => {
        if (effect === undefined) throw new Error(`EDIT receipt calculation omitted effect ${index}`);
        return effect;
    });
};

const contextRadius = (): number => {
    const raw = process.env.PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
            `PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES must be a non-negative safe integer, got ${JSON.stringify(raw)}`,
        );
    }
    return value;
};

const addContext = (
    effects: readonly EffectWithContextRange[],
    updated: string,
): EditEffectReceipt[] => {
    const lines = splitLines(updated);
    const radius = contextRadius();
    return effects.map((effect) => {
        const selected = new Set<number>();
        const addRange = (first: number, last: number): void => {
            for (
                let line = Math.max(1, first);
                line <= Math.min(lines.length, last);
                line += 1
            ) {
                selected.add(line);
            }
        };
        const firstChanged = effect.resultStartLine;
        const lastChanged = Math.max(firstChanged, effect.resultEndLine);
        addRange(firstChanged - radius, firstChanged - 1);
        if (effect.inserted > 0) {
            addRange(firstChanged, firstChanged + radius - 1);
            addRange(lastChanged - radius + 1, lastChanged);
            addRange(lastChanged + 1, lastChanged + radius);
        } else {
            addRange(firstChanged, firstChanged + radius - 1);
        }
        const context = [...selected]
            .sort((left, right) => left - right)
            .map((line) => `${line}:${lines[line - 1]}`);
        const {
            resultStartLine: _resultStartLine,
            resultEndLine: _resultEndLine,
            ...receipt
        } = effect;
        return {
            ...receipt,
            context: context.join("\n"),
        };
    });
};

export const editReceipt = (
    original: string,
    updated: string,
    edits: readonly ReceiptEdit[],
): AppliedEditBatchReceipt => {
    const unit: EditReceiptUnit = edits.some(({ marker }) => marker.marks.length === 4)
        ? "codePoints"
        : "lines";
    const effects = unit === "codePoints"
        ? codePointEffects(original, updated, edits)
        : lineEffects(original, edits);
    return {
        revision: createHash("sha256").update(updated).digest("hex"),
        unit,
        before: unit === "codePoints"
            ? codePointCount(original)
            : splitLines(original).length,
        after: unit === "codePoints"
            ? codePointCount(updated)
            : splitLines(updated).length,
        effects: addContext(effects, updated),
    };
};

export const reviewerReplacementReceipt = (
    original: string,
    updated: string,
    authored: EditBatchReceipt,
): ReviewerReplacementEditBatchReceipt => {
    const exact = assertEditBatchReceipt(authored);
    if ("disposition" in exact) {
        throw new InvalidOperationResultError(
            "A reviewer replacement cannot supersede an already replaced EDIT batch receipt.",
        );
    }
    const landed = editReceipt(
        original,
        updated,
        [{ marker: { marks: [1, -1] }, body: updated }],
    );
    const replacement = landed.effects[0];
    if (replacement === undefined) {
        throw new Error("Reviewer replacement receipt omitted its landed effect.");
    }
    return {
        revision: landed.revision,
        unit: landed.unit,
        before: landed.before,
        after: landed.after,
        disposition: "reviewer-replaced",
        superseded: exact.effects.map(({ requested }) => requested),
        replacement,
    };
};
