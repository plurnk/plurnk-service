import type { TextRegion } from "@plurnk/plurnk-contracts";
import TextCoordinates from "./TextCoordinates.ts";
import type { MimeSymbol } from "./types.ts";

type RegionKeys = "line" | "column" | "endLine" | "endColumn";

export type TreeSitterSymbolProjection = Omit<MimeSymbol, RegionKeys> & {
    readonly span: TreeSitterSpan;
};

export type TreeSitterEndBoundary = "start" | "end";

export interface TreeSitterSpan {
    readonly startNode: TreeSitterSourceNode;
    readonly endNode: TreeSitterSourceNode;
    readonly endBoundary: TreeSitterEndBoundary;
}

export interface TreeSitterPoint {
    readonly row: number;
    readonly column: number;
}

export interface TreeSitterSourceNode {
    readonly startIndex?: number;
    readonly endIndex?: number;
    readonly startPosition: TreeSitterPoint;
    readonly endPosition: TreeSitterPoint;
}

interface AntlrTokenSpan {
    readonly start?: number;
    readonly stop?: number;
}

interface AntlrContextSpan {
    readonly start?: AntlrTokenSpan | null;
    readonly stop?: AntlrTokenSpan | null;
}

export class ParserCoordinateError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ParserCoordinateError";
    }
}

export function isParserCoordinateError(error: unknown): error is ParserCoordinateError {
    return error instanceof ParserCoordinateError
        || (typeof error === "object"
            && error !== null
            && (error as { name?: unknown }).name === "ParserCoordinateError");
}

export function treeSitterSpan(
    startNode: TreeSitterSourceNode,
    endNode: TreeSitterSourceNode = startNode,
    endBoundary: TreeSitterEndBoundary = "end",
): TreeSitterSpan {
    return { startNode, endNode, endBoundary };
}

export function materializeTreeSitterSymbols(
    content: string,
    projections: readonly TreeSitterSymbolProjection[],
): MimeSymbol[] {
    const coordinates = new ParserCoordinates(content);
    return projections.map(({ span, ...symbol }) => {
        const region = coordinates.treeSitterSpan(span);
        return {
            ...symbol,
            line: region.startLine,
            column: region.startColumn,
            endLine: region.endLine,
            endColumn: region.endColumn,
        };
    });
}

/**
 * Converts parser-native source offsets into {§text-region} coordinates.
 * Tree-sitter's string API reports JavaScript UTF-16 offsets; antlr4ng's
 * CharStream reports Unicode-code-point offsets. TextCoordinates remains the
 * sole owner of line splitting and public 1-based code-point columns.
 */
export default class ParserCoordinates {
    readonly #content: string;
    readonly #text: TextCoordinates;
    readonly #lines;
    #codePointBoundaries: number[] | null = null;

    constructor(content: string) {
        this.#content = content;
        this.#text = new TextCoordinates(content);
        this.#lines = TextCoordinates.lines(content);
    }

    treeSitterSpan(span: TreeSitterSpan): TextRegion {
        const start = this.#treeSitterBoundary(span.startNode, "start");
        const end = this.#treeSitterBoundary(span.endNode, span.endBoundary);
        return this.#regionFromOffsets("Tree-sitter", start, end);
    }

    treeSitterNode(node: TreeSitterSourceNode): TextRegion {
        const indexed = this.#treeSitterIndexes(node);
        if (indexed !== null) {
            return this.#regionFromOffsets("Tree-sitter", indexed.start, indexed.end);
        }
        const start = this.#offsetAtTreeSitterPoint(node.startPosition, "start");
        const end = this.#offsetAtTreeSitterPoint(node.endPosition, "end");
        return this.#regionFromOffsets("Tree-sitter", start, end);
    }

    antlrContext(context: unknown): TextRegion {
        const span = context as AntlrContextSpan;
        const start = this.#antlrTokenBoundary(span.start, "start");
        const stop = this.#antlrTokenBoundary(span.stop ?? span.start, "end");
        return this.#regionFromOffsets("ANTLR", start, Math.max(start, stop));
    }

    antlrToken(token: unknown): TextRegion {
        const start = this.#antlrTokenBoundary(token as AntlrTokenSpan, "start");
        const stop = this.#antlrTokenBoundary(token as AntlrTokenSpan, "end");
        return this.#regionFromOffsets("ANTLR", start, Math.max(start, stop));
    }

    #treeSitterBoundary(node: TreeSitterSourceNode, boundary: TreeSitterEndBoundary): number {
        const indexed = this.#treeSitterIndexes(node);
        if (indexed !== null) return indexed[boundary];
        return this.#offsetAtTreeSitterPoint(
            boundary === "start" ? node.startPosition : node.endPosition,
            boundary,
        );
    }

    #treeSitterIndexes(node: TreeSitterSourceNode): { start: number; end: number } | null {
        const indexed = node as { startIndex?: unknown; endIndex?: unknown };
        const hasStart = indexed.startIndex !== undefined;
        const hasEnd = indexed.endIndex !== undefined;
        if (!hasStart && !hasEnd) return null;
        if (!hasStart || !hasEnd) {
            throw new ParserCoordinateError("Tree-sitter node has an incomplete native offset pair.");
        }
        if (!isOffset(indexed.startIndex) || !isOffset(indexed.endIndex)) {
            throw new ParserCoordinateError("Tree-sitter node has invalid native offsets.");
        }
        return { start: indexed.startIndex, end: indexed.endIndex };
    }

    #offsetAtTreeSitterPoint(point: unknown, boundary: string): number {
        if (!isPoint(point)) {
            throw new ParserCoordinateError(`Tree-sitter ${boundary} point is invalid.`);
        }
        const line = this.#lines[point.row];
        if (line === undefined) {
            throw new ParserCoordinateError(`Tree-sitter ${boundary} row ${point.row} is outside the source.`);
        }
        const offset = line.start + point.column;
        if (offset > line.contentEnd) {
            throw new ParserCoordinateError(
                `Tree-sitter ${boundary} column ${point.column} is outside row ${point.row}.`,
            );
        }
        return offset;
    }

    #antlrTokenBoundary(token: AntlrTokenSpan | null | undefined, boundary: "start" | "end"): number {
        if (token === null || token === undefined) {
            throw new ParserCoordinateError(`ANTLR ${boundary} token is missing.`);
        }
        const codePointOffset = boundary === "start"
            ? token.start
            : token.stop === undefined
                ? undefined
                : token.stop + 1;
        if (!isOffset(codePointOffset)) {
            throw new ParserCoordinateError(`ANTLR ${boundary} token offset is invalid.`);
        }
        const boundaries = this.#antlrCodePointBoundaries();
        const offset = boundaries[codePointOffset];
        if (offset === undefined) {
            throw new ParserCoordinateError(
                `ANTLR ${boundary} offset ${codePointOffset} is outside the source.`,
            );
        }
        return offset;
    }

    #antlrCodePointBoundaries(): number[] {
        if (this.#codePointBoundaries !== null) return this.#codePointBoundaries;
        const boundaries = [0];
        let offset = 0;
        for (const codePoint of this.#content) {
            offset += codePoint.length;
            boundaries.push(offset);
        }
        this.#codePointBoundaries = boundaries;
        return boundaries;
    }

    #regionFromOffsets(parser: string, start: number, end: number): TextRegion {
        if (end < start) {
            throw new ParserCoordinateError(`${parser} span ${start}..<${end} is inverted.`);
        }
        const region = this.#text.regionFromOffsets(start, end);
        if (region === null) {
            throw new ParserCoordinateError(
                `${parser} span ${start}..<${end} does not align to source code-point boundaries.`,
            );
        }
        return region;
    }
}

function isOffset(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPoint(value: unknown): value is TreeSitterPoint {
    if (typeof value !== "object" || value === null) return false;
    const point = value as { row?: unknown; column?: unknown };
    return isOffset(point.row) && isOffset(point.column);
}
