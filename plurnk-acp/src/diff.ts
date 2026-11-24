// {§acp-body-reference} {§acp-plurnk-metadata} Myers O(ND) unified diff generator and DiffChange classification.

import type { DiffChange } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { structuredPatch } from "diff";
import { isRecord } from "@plurnk/plurnk-contracts";

const ensureTrailingNewline = (text: string): string =>
    text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;

export const buildUnifiedDiff = (
    filePath: string,
    oldText: string,
    newText: string,
    contextLines = 3,
): string => {
    const normalizedPath = filePath.replace(/^\/+/u, "");
    const patch = structuredPatch(
        `a/${normalizedPath}`,
        `b/${normalizedPath}`,
        ensureTrailingNewline(oldText),
        ensureTrailingNewline(newText),
        undefined,
        undefined,
        { context: contextLines },
    );
    const out: string[] = [
        `--- a/${normalizedPath}`,
        `+++ b/${normalizedPath}`,
    ];
    for (const hunk of patch.hunks) {
        const oldStart = hunk.oldLines === 0 ? 0 : hunk.oldStart;
        const newStart = hunk.newLines === 0 ? 0 : hunk.newStart;
        out.push(`@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`);
        for (const line of hunk.lines) {
            if (line.startsWith("\\")) continue;
            out.push(line);
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
    if (args.op === "move" || args.op === "copy") {
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
            return args.op === "move"
                ? [{ operation: "move", oldPath, path: destPath }]
                : [{ operation: "copy", oldPath, path: destPath }];
        }
    }
    if (
        args.op === "kill" ||
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
