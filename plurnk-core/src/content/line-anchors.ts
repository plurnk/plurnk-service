import { createHash } from "node:crypto";
import type { EditLineMarker, LineMarker } from "@plurnk/plurnk-contracts";
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
export default class LineAnchors {
    static readonly #ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    static readonly #LENGTH = 5;
    static readonly #RADIUS = 4;
    static readonly #MODULUS = BigInt(LineAnchors.#ALPHABET.length) ** BigInt(LineAnchors.#LENGTH);
    static readonly #TOKEN = /^@[0-9A-Za-z]{5}$/;
    static readonly #PREFIXED_LINE = /^@[0-9A-Za-z]{5}:[1-9]\d*:/;

    static isAnchor(value: unknown): value is string {
        return typeof value === "string" && LineAnchors.#TOKEN.test(value);
    }

    static isAnchoredLine(value: string): boolean {
        return LineAnchors.#PREFIXED_LINE.test(value);
    }

    static hasAnchor(marker: EditLineMarker | null): boolean {
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

    static #encode(identity: string, lineNumber: number, context: readonly string[]): string {
        if (identity.length === 0) throw new TypeError("A line anchor requires a non-empty resource identity.");
        if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
            throw new RangeError(`A line anchor requires a positive safe line number, got ${lineNumber}.`);
        }
        const digest = createHash("sha256")
            .update(JSON.stringify(["plurnk-line-anchor-v1", identity, lineNumber, context]))
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
        const lines = TextCoordinates.logicalLines(content);
        const bodies = lines.map((line) => content.slice(line.start, line.contentEnd));
        return bodies.map((_, index) => LineAnchors.#encode(
            identity,
            index + 1,
            bodies.slice(
                Math.max(0, index - LineAnchors.#RADIUS),
                index + LineAnchors.#RADIUS + 1,
            ),
        ));
    }

    static token(identity: string, lineNumber: number, content: string): string {
        const token = LineAnchors.tokens(identity, content)[lineNumber - 1];
        if (token === undefined) {
            throw new RangeError(`Line ${lineNumber} is outside the available line range.`);
        }
        return token;
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

    static render(content: string, startLine: number, anchors: readonly string[]): string {
        if (content.length === 0) {
            if (anchors.length !== 0) throw new TypeError("An empty READ projection cannot carry line anchors.");
            return "";
        }
        if (!Number.isSafeInteger(startLine) || startLine < 1) {
            throw new RangeError(`Anchored rendering requires a positive safe start line, got ${startLine}.`);
        }
        LineAnchors.assertProjection(content, anchors);
        const lines = TextCoordinates.logicalLines(content);
        return lines.map((line, index) => {
            const lineNumber = startLine + index;
            const body = content.slice(line.start, line.contentEnd);
            return `${anchors[index]}:${lineNumber}:${body}${line.separator}`;
        }).join("");
    }

    static resolve(anchors: readonly string[], marker: EditLineMarker): LineAnchorResolution {
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
}
