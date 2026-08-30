import { createHash } from "node:crypto";
import type { LineMarker, TextLineMarker } from "@plurnk/plurnk-contracts";
import type { EditStatement } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";

export type LineAnchorFailure = {
    readonly kind: "invalid" | "stale" | "ambiguous";
    readonly anchor: string;
    readonly matches?: readonly number[];
};

export type LineAnchorResolution =
    | { readonly ok: true; readonly marker: LineMarker }
    | { readonly ok: false; readonly failure: LineAnchorFailure };

export interface LineAnchorCheck {
    readonly anchor: string;
    readonly line: number;
}

export interface LineAnchorPrecondition {
    readonly identity: string;
    readonly checks: readonly LineAnchorCheck[];
}

// A rendered anchor is a short, copyable validation handle, never resource
// identity by itself. The universal READ projector supplies snapshot anchors;
// current resolution fails closed on zero or multiple matches.
// {§line-anchors} v2 (#428): the ordinal is not hashed. A line keeps its anchor
// wherever it moves while its content and neighborhood are unchanged, so the
// model's own earlier edits above a line never stale the anchors below it;
// identical neighborhoods share one anchor and resolve as ambiguous, never as
// a silent landing on a twin. The line's offset within its window (`min(L-1, C)`)
// is hashed so that lines inside the first C lines - whose windows are the same
// head-truncated slice - stay distinct; past the head the offset is constant.
export default class LineAnchors {
    static readonly invalidCoordinateDetail = "A line anchor occupies a column slot in <SL,SC,EL,EC>; columns must be numeric.";
    static readonly invalidCoordinateRecovery = "Use <@start,@end> for an inclusive whole-line anchor range.";
    static readonly #ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    static readonly #LENGTH = 5;
    static readonly #MODULUS = BigInt(LineAnchors.#ALPHABET.length) ** BigInt(LineAnchors.#LENGTH);
    static readonly #MAX_LINE_NUMBER_WIDTH = String(Number.MAX_SAFE_INTEGER).length;
    static readonly #TOKEN = /^@[0-9A-Za-z]{5}$/;
    static readonly #PREFIXED_LINE = /^@[0-9A-Za-z]{5} +[1-9]\d*:/;

    static isAnchor(value: unknown): value is string {
        return typeof value === "string" && LineAnchors.#TOKEN.test(value);
    }

    static isAnchoredLine(value: string): boolean {
        return LineAnchors.#PREFIXED_LINE.test(value);
    }

    static isLineNumberWidth(value: unknown): value is number {
        return Number.isSafeInteger(value)
            && (value as number) >= 1
            && (value as number) <= LineAnchors.#MAX_LINE_NUMBER_WIDTH;
    }

    static hasAnchor(marker: TextLineMarker | null): marker is TextLineMarker {
        return marker?.marks.some((mark) => typeof mark === "string") ?? false;
    }

    static assertResolved(
        statements: readonly EditStatement[],
    ): asserts statements is readonly ResolvedEditStatement[] {
        if (statements.some(({ lineMarker }) => LineAnchors.hasAnchor(lineMarker))) {
            throw new TypeError("An unresolved line anchor crossed the core-to-scheme boundary.");
        }
    }

    static satisfies(precondition: LineAnchorPrecondition, content: string): boolean {
        if (precondition.identity.length === 0 || precondition.checks.length === 0) {
            throw new TypeError("A line-anchor precondition requires an identity and at least one check.");
        }
        const current = LineAnchors.tokens(precondition.identity, content);
        return precondition.checks.every(({ anchor, line }) => {
            if (!LineAnchors.isAnchor(anchor) || !Number.isSafeInteger(line) || line < 1) {
                throw new TypeError("A line-anchor precondition contains an invalid check.");
            }
            return current[line - 1] === anchor;
        });
    }

    static #contextLines(): number {
        const raw = process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError(
                `PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES must be a non-negative safe integer, got ${JSON.stringify(raw)}`,
            );
        }
        return value;
    }

    static #encode(
        identity: string,
        contextLines: number,
        offset: number,
        context: readonly string[],
    ): string {
        if (identity.length === 0) throw new TypeError("A line anchor requires a non-empty resource identity.");
        const digest = createHash("sha256")
            .update(JSON.stringify(["plurnk-line-anchor-v2", identity, contextLines, offset, context]))
            .digest("hex");
        let value = BigInt(`0x${digest}`) % LineAnchors.#MODULUS;
        let encoded = "";
        for (let index = 0; index < LineAnchors.#LENGTH; index += 1) {
            encoded = LineAnchors.#ALPHABET[Number(value % BigInt(LineAnchors.#ALPHABET.length))]! + encoded;
            value /= BigInt(LineAnchors.#ALPHABET.length);
        }
        return `@${encoded}`;
    }

    static tokens(identity: string, content: string): readonly string[] {
        const contextLines = LineAnchors.#contextLines();
        const lines = TextCoordinates.logicalLines(content);
        const bodies = lines.map((line) => content.slice(line.start, line.contentEnd));
        return bodies.map((_, index) => {
            const start = Math.max(0, index - contextLines);
            return LineAnchors.#encode(identity, contextLines, index - start, bodies.slice(start, index + contextLines + 1));
        });
    }

    static token(identity: string, lineNumber: number, content: string): string {
        const token = LineAnchors.tokens(identity, content)[lineNumber - 1];
        if (token === undefined) {
            throw new RangeError(`Line ${lineNumber} is outside the available line range.`);
        }
        return token;
    }

    static lineNumberWidth(content: string): number {
        return String(Math.max(TextCoordinates.logicalLines(content).length, 1)).length;
    }

    static project(
        identity: string,
        completeContent: string,
        projectedContent: string,
        startLine: number,
    ): readonly string[] {
        if (projectedContent.length === 0) return [];
        if (!Number.isSafeInteger(startLine) || startLine < 1) {
            throw new RangeError(`Anchored projection requires a positive safe start line, got ${startLine}.`);
        }
        const count = TextCoordinates.logicalLines(projectedContent).length;
        const projected = LineAnchors.tokens(identity, completeContent).slice(startLine - 1, startLine - 1 + count);
        if (projected.length !== count) {
            throw new RangeError("The projected READ content extends beyond the complete canonical representation.");
        }
        return projected;
    }

    static assertProjection(content: string, anchors: unknown): asserts anchors is readonly string[] {
        const lineCount = TextCoordinates.logicalLines(content).length;
        if (
            !Array.isArray(anchors)
            || anchors.length !== lineCount
            || anchors.some((anchor) => !LineAnchors.isAnchor(anchor))
        ) {
            throw new TypeError("READ line anchors must align one-for-one with its projected physical lines.");
        }
    }

    static render(
        content: string,
        startLine: number,
        anchors: readonly string[],
        lineNumberWidth: number,
    ): string {
        if (content.length === 0) {
            if (anchors.length !== 0) throw new TypeError("An empty READ projection cannot carry line anchors.");
            return "";
        }
        if (!Number.isSafeInteger(startLine) || startLine < 1) {
            throw new RangeError(`Anchored rendering requires a positive safe start line, got ${startLine}.`);
        }
        LineAnchors.assertProjection(content, anchors);
        const lines = TextCoordinates.logicalLines(content);
        const finalLine = startLine + lines.length - 1;
        if (
            !LineAnchors.isLineNumberWidth(lineNumberWidth)
            || lineNumberWidth < String(finalLine).length
        ) {
            throw new RangeError(
                `Anchored rendering requires a line-number width covering line ${finalLine}, got ${lineNumberWidth}.`,
            );
        }
        return lines.map((line, index) => {
            const lineNumber = startLine + index;
            const body = content.slice(line.start, line.contentEnd);
            const separator = " ".repeat(lineNumberWidth - String(lineNumber).length + 1);
            return `${anchors[index]}${separator}${lineNumber}:${body}${line.separator}`;
        }).join("");
    }

    static resolve(anchors: readonly string[], marker: TextLineMarker): LineAnchorResolution {
        const anchorIndexes = marker.marks.flatMap((mark, index) => typeof mark === "string" ? [index] : []);
        if (anchorIndexes.length === 0) {
            return { ok: true, marker: { marks: [...marker.marks] as [number, ...number[]] } };
        }
        const permitted = marker.marks.length === 1
            ? new Set([0])
            : marker.marks.length === 2
                ? new Set([0, 1])
                : marker.marks.length === 3 || marker.marks.length === 4
                    ? new Set([0, 2])
                    : new Set<number>();
        for (const index of anchorIndexes) {
            const anchor = marker.marks[index] as string;
            if (!LineAnchors.isAnchor(anchor) || !permitted.has(index)) {
                return { ok: false, failure: { kind: "invalid", anchor } };
            }
        }

        const matches = new Map<string, number[]>();
        for (const [index, anchor] of anchors.entries()) {
            const lineNumber = index + 1;
            if (!LineAnchors.isAnchor(anchor)) {
                throw new TypeError(`READ supplied an invalid line anchor at line ${lineNumber}.`);
            }
            const found = matches.get(anchor);
            if (found === undefined) matches.set(anchor, [lineNumber]);
            else found.push(lineNumber);
        }

        const resolved = [...marker.marks];
        for (const index of anchorIndexes) {
            const anchor = marker.marks[index] as string;
            const found = matches.get(anchor) ?? [];
            if (found.length === 0) {
                return { ok: false, failure: { kind: "stale", anchor } };
            }
            if (found.length > 1) {
                return { ok: false, failure: { kind: "ambiguous", anchor, matches: found } };
            }
            resolved[index] = found[0]!;
        }
        return {
            ok: true,
            marker: { marks: resolved as [number, ...number[]] },
        };
    }

    static checks(authored: TextLineMarker, resolved: LineMarker): readonly LineAnchorCheck[] {
        if (authored.marks.length !== resolved.marks.length) {
            throw new TypeError("A resolved line marker must preserve its authored arity.");
        }
        return authored.marks.flatMap((mark, index) => {
            if (typeof mark !== "string") return [];
            const line = resolved.marks[index];
            if (!LineAnchors.isAnchor(mark) || typeof line !== "number") {
                throw new TypeError("A line anchor did not lower to a numeric line.");
            }
            return [{ anchor: mark, line }];
        });
    }
}
