// {§acp-body-reference} {§acp-plurnk-metadata} Line-level unified diff generator with context hunks and DiffChange classification.

import type { DiffChange } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isRecord } from "@plurnk/plurnk-contracts";

interface DiffOp {
    readonly type: "keep" | "del" | "add";
    readonly text: string;
}

const splitLines = (text: string): string[] => {
    if (text.length === 0) return [];
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
};

const computeMiddleOps = (oldMid: readonly string[], newMid: readonly string[]): DiffOp[] => {
    const n = oldMid.length;
    const m = newMid.length;
    if (n === 0 && m === 0) return [];
    if (n === 0) return newMid.map((text) => ({ type: "add", text }));
    if (m === 0) return oldMid.map((text) => ({ type: "del", text }));

    // Standard LCS dynamic programming table over the trimmed middle region.
    const width = m + 1;
    const dp = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
        const oldLine = oldMid[i];
        const rowOffset = i * width;
        const nextRowOffset = (i + 1) * width;
        for (let j = m - 1; j >= 0; j -= 1) {
            dp[rowOffset + j] =
                oldLine === newMid[j]
                    ? (dp[nextRowOffset + j + 1] ?? 0) + 1
                    : Math.max(dp[nextRowOffset + j] ?? 0, dp[rowOffset + j + 1] ?? 0);
        }
    }

    const ops: DiffOp[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (oldMid[i] === newMid[j]) {
            ops.push({ type: "keep", text: oldMid[i] });
            i += 1;
            j += 1;
        } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
            ops.push({ type: "del", text: oldMid[i] });
            i += 1;
        } else {
            ops.push({ type: "add", text: newMid[j] });
            j += 1;
        }
    }
    while (i < n) {
        ops.push({ type: "del", text: oldMid[i] });
        i += 1;
    }
    while (j < m) {
        ops.push({ type: "add", text: newMid[j] });
        j += 1;
    }
    return ops;
};

const computeEditOps = (oldLines: readonly string[], newLines: readonly string[]): DiffOp[] => {
    let prefix = 0;
    const minLen = Math.min(oldLines.length, newLines.length);
    while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
        prefix += 1;
    }
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
    }

    const ops: DiffOp[] = [];
    for (let i = 0; i < prefix; i += 1) {
        ops.push({ type: "keep", text: oldLines[i] });
    }
    ops.push(...computeMiddleOps(oldLines.slice(prefix, oldEnd), newLines.slice(prefix, newEnd)));
    for (let i = oldEnd; i < oldLines.length; i += 1) {
        ops.push({ type: "keep", text: oldLines[i] });
    }
    return ops;
};

export const buildUnifiedDiff = (
    filePath: string,
    oldText: string,
    newText: string,
    contextLines = 3,
): string => {
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    const ops = computeEditOps(oldLines, newLines);

    // Annotate each op with its 1-based line coordinates in old and new.
    let oldLine = 1;
    let newLine = 1;
    const indexed = ops.map((op) => {
        const entry = {
            ...op,
            oldPos: oldLine,
            newPos: newLine,
        };
        if (op.type === "keep" || op.type === "del") oldLine += 1;
        if (op.type === "keep" || op.type === "add") newLine += 1;
        return entry;
    });

    // Identify changed indices and group into hunks with contextLines padding.
    const changeRanges: Array<{ start: number; end: number }> = [];
    for (let idx = 0; idx < indexed.length; idx += 1) {
        if (indexed[idx].type !== "keep") {
            const start = Math.max(0, idx - contextLines);
            const end = Math.min(indexed.length - 1, idx + contextLines);
            const prev = changeRanges.at(-1);
            if (prev !== undefined && start <= prev.end + 1) {
                prev.end = Math.max(prev.end, end);
            } else {
                changeRanges.push({ start, end });
            }
        }
    }

    const normalizedPath = filePath.replace(/^\/+/u, "");
    const out: string[] = [
        `--- a/${normalizedPath}`,
        `+++ b/${normalizedPath}`,
    ];

    for (const range of changeRanges) {
        const slice = indexed.slice(range.start, range.end + 1);
        const oldCount = slice.filter((op) => op.type === "keep" || op.type === "del").length;
        const newCount = slice.filter((op) => op.type === "keep" || op.type === "add").length;
        const oldStart = oldCount === 0 ? 0 : slice[0].oldPos;
        const newStart = newCount === 0 ? 0 : slice[0].newPos;
        out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
        for (const op of slice) {
            const prefix = op.type === "keep" ? " " : op.type === "del" ? "-" : "+";
            out.push(`${prefix}${op.text}`);
        }
    }

    return out.join("\n");
};

const extractOperandPath = (operand: unknown): string | null => {
    if (!isRecord(operand)) return null;
    if (isRecord(operand.target)) {
        if (typeof operand.target.pathname === "string" && operand.target.pathname.length > 0) {
            return operand.target.pathname;
        }
        if (typeof operand.target.raw === "string" && operand.target.raw.length > 0) {
            return operand.target.raw;
        }
    }
    if (typeof operand.pathname === "string" && operand.pathname.length > 0) {
        return operand.pathname;
    }
    if (typeof operand.raw === "string" && operand.raw.length > 0) {
        return operand.raw;
    }
    return null;
};

export const buildDiffChanges = (args: {
    readonly op: string | null;
    readonly path: string;
    readonly statusRx?: number;
    readonly attrs?: Readonly<Record<string, unknown>>;
    readonly parsedTx?: unknown;
}): DiffChange[] => {
    const attrs = args.attrs ?? {};
    const txRec = isRecord(args.parsedTx) ? args.parsedTx : null;
    if (args.op === "MOVE" || args.op === "COPY") {
        const oldPath =
            (typeof attrs.oldPath === "string" && attrs.oldPath.length > 0 ? attrs.oldPath : null) ??
            (typeof attrs.from === "string" && attrs.from.length > 0 ? attrs.from : null) ??
            extractOperandPath(txRec?.source) ??
            args.path;
        const destPath =
            (typeof attrs.destination === "string" && attrs.destination.length > 0 ? attrs.destination : null) ??
            (typeof attrs.to === "string" && attrs.to.length > 0 ? attrs.to : null) ??
            extractOperandPath(txRec?.destination) ??
            args.path;
        if (oldPath.length > 0 && destPath.length > 0) {
            return args.op === "MOVE"
                ? [{ operation: "move", oldPath, path: destPath }]
                : [{ operation: "copy", oldPath, path: destPath }];
        }
    }
    if (
        args.op === "KILL" ||
        attrs.operation === "delete" ||
        attrs.deleted === true ||
        (typeof attrs.original === "string" &&
            attrs.original.length > 0 &&
            attrs.patched === "" &&
            args.statusRx === 204)
    ) {
        return [{ operation: "delete", path: args.path }];
    }
    if (
        args.statusRx === 201 ||
        attrs.operation === "add" ||
        attrs.created === true ||
        (attrs.original === "" && typeof attrs.patched === "string" && attrs.patched.length > 0)
    ) {
        return [{ operation: "add", path: args.path }];
    }
    return [{ operation: "modify", path: args.path }];
};
