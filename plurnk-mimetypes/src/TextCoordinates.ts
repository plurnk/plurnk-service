import type { TextRegion } from "@plurnk/plurnk-contracts";

export interface TextLine {
    readonly start: number;
    readonly contentEnd: number;
    readonly end: number;
    readonly separator: string;
}

export interface TextPosition {
    readonly line: number;
    readonly column: number;
}

// #321: a column 416 carries the line's current text so the model corrects
// its coordinate from the receipt instead of spending a re-READ round-trip.
const LINE_PREVIEW_CODEPOINTS = 96;

export default class TextCoordinates {
    readonly #content: string;
    readonly #lines: TextLine[];
    readonly #columnOffsets = new Map<number, number[]>();

    constructor(content: string) {
        this.#content = content;
        this.#lines = TextCoordinates.#scanLines(content);
    }

    static lines(content: string): TextLine[] {
        return TextCoordinates.#scanLines(content);
    }

    static #scanLines(content: string): TextLine[] {
        const lines: TextLine[] = [];
        const newline = /\r\n|\r|\n/g;
        let start = 0;
        for (const match of content.matchAll(newline)) {
            const index = match.index;
            const separator = match[0];
            lines.push({
                start,
                contentEnd: index,
                end: index + separator.length,
                separator,
            });
            start = index + separator.length;
        }
        lines.push({
            start,
            contentEnd: content.length,
            end: content.length,
            separator: "",
        });
        return lines;
    }

    static logicalLines(content: string): TextLine[] {
        return new TextCoordinates(content).logicalLines();
    }

    logicalLines(): TextLine[] {
        if (this.#content.length === 0) return [];
        return this.#lines.length > 1 && this.#lines.at(-1)?.start === this.#content.length
            ? this.#lines.slice(0, -1)
            : this.#lines.slice();
    }

    static offsetAtPosition(
        content: string,
        lineNumber: number,
        column: number,
    ): number {
        return new TextCoordinates(content).offsetAtPosition(lineNumber, column);
    }

    offsetAtPosition(lineNumber: number, column: number): number {
        if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
            throw new RangeError(`Line ${lineNumber} must be a positive integer.`);
        }
        if (!Number.isSafeInteger(column) || column < 1) {
            throw new RangeError(`Column ${column} on line ${lineNumber} must be a positive integer.`);
        }
        const line = this.#lines[lineNumber - 1];
        if (line === undefined) {
            throw new RangeError(
                `Line ${lineNumber} is outside the available line range 1..${this.#lines.length}.`,
            );
        }
        const offsets = this.#offsetsForLine(lineNumber - 1);
        const offset = offsets[column - 1];
        if (offset === undefined) {
            const text = [...this.#content.slice(line.start, line.contentEnd)];
            const preview = text.length > LINE_PREVIEW_CODEPOINTS
                ? `${text.slice(0, LINE_PREVIEW_CODEPOINTS - 1).join("")}…`
                : text.join("");
            throw new RangeError(
                `Column ${column} is outside line ${lineNumber}'s available column range 1..${offsets.length}. Line ${lineNumber}: \`${preview}\``,
            );
        }
        return offset;
    }

    static positionAtOffset(content: string, offset: number): TextPosition | null {
        return new TextCoordinates(content).positionAtOffset(offset);
    }

    positionAtOffset(offset: number): TextPosition | null {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.#content.length) {
            return null;
        }
        const index = this.#lineIndexAtOffset(offset);
        const line = this.#lines[index]!;
        if (offset > line.contentEnd) return null;
        const columnIndex = this.#offsetsForLine(index).indexOf(offset);
        return columnIndex === -1
            ? null
            : { line: index + 1, column: columnIndex + 1 };
    }

    static regionFromOffsets(
        content: string,
        start: number,
        end: number,
    ): TextRegion | null {
        return new TextCoordinates(content).regionFromOffsets(start, end);
    }

    regionFromOffsets(start: number, end: number): TextRegion | null {
        if (end < start) return null;
        const first = this.positionAtOffset(start);
        const final = this.positionAtOffset(end);
        if (first === null || final === null) return null;
        return {
            startLine: first.line,
            startColumn: first.column,
            endLine: final.line,
            endColumn: final.column,
        };
    }

    static enclosingRegionFromOffsets(
        content: string,
        start: number,
        end: number,
    ): TextRegion | null {
        return new TextCoordinates(content).enclosingRegionFromOffsets(start, end);
    }

    enclosingRegionFromOffsets(start: number, end: number): TextRegion | null {
        if (
            !Number.isSafeInteger(start)
            || !Number.isSafeInteger(end)
            || start < 0
            || end < start
            || end > this.#content.length
        ) {
            return null;
        }
        const exact = this.regionFromOffsets(start, end);
        if (exact !== null) return exact;
        const first = this.#positionAtOrBeforeOffset(start);
        const final = this.#positionAtOrAfterOffset(end);
        if (first === null || final === null) return null;
        return {
            startLine: first.line,
            startColumn: first.column,
            endLine: final.line,
            endColumn: final.column,
        };
    }

    static lineRegion(
        content: string,
        startLine: number,
        endLine: number,
    ): TextRegion | null {
        return new TextCoordinates(content).lineRegion(startLine, endLine);
    }

    lineRegion(
        startLine: number,
        endLine: number,
    ): TextRegion | null {
        if (
            !Number.isSafeInteger(startLine)
            || !Number.isSafeInteger(endLine)
            || startLine < 1
            || endLine < startLine
        ) {
            return null;
        }
        const finalScanned = this.#lines.at(-1);
        const addressableCount = this.#content.length === 0
            ? 1
            : finalScanned?.start === this.#content.length
                ? this.#lines.length - 1
                : this.#lines.length;
        if (endLine > addressableCount) return null;
        const first = this.#lines[startLine - 1];
        const final = this.#lines[endLine - 1];
        if (first === undefined || final === undefined) return null;
        return this.regionFromOffsets(first.start, final.contentEnd);
    }

    #lineIndexAtOffset(offset: number): number {
        let low = 0;
        let high = this.#lines.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.#lines[middle]!.start <= offset) low = middle + 1;
            else high = middle;
        }
        return Math.max(0, low - 1);
    }

    #positionAtOrBeforeOffset(offset: number): TextPosition | null {
        const index = this.#lineIndexAtOffset(offset);
        const line = this.#lines[index];
        if (line === undefined) return null;
        const offsets = this.#offsetsForLine(index);
        for (let i = offsets.length - 1; i >= 0; i -= 1) {
            if (offsets[i]! <= offset) {
                return { line: index + 1, column: i + 1 };
            }
        }
        return null;
    }

    #positionAtOrAfterOffset(offset: number): TextPosition | null {
        const index = this.#lineIndexAtOffset(offset);
        const line = this.#lines[index];
        if (line === undefined) return null;
        const offsets = this.#offsetsForLine(index);
        const columnIndex = offsets.findIndex((candidate) => candidate >= offset);
        if (columnIndex !== -1) {
            return { line: index + 1, column: columnIndex + 1 };
        }
        const next = this.#lines[index + 1];
        return next === undefined
            ? null
            : { line: index + 2, column: 1 };
    }

    #offsetsForLine(index: number): number[] {
        let offsets = this.#columnOffsets.get(index);
        if (offsets !== undefined) return offsets;
        const line = this.#lines[index]!;
        offsets = [line.start];
        let offset = line.start;
        for (const codePoint of this.#content.slice(line.start, line.contentEnd)) {
            offset += codePoint.length;
            offsets.push(offset);
        }
        this.#columnOffsets.set(index, offsets);
        return offsets;
    }
}
