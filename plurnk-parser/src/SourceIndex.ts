import type { Position } from "@plurnk/plurnk-contracts";

const GLUED_TRANSCRIPT_HEADING = /### log:\/\/\/\d+\/\d+\/\d+\/\S*|\*\*[A-Za-z0-9_$-]+:\s*[A-Za-z0-9_$-]+(?:\s+[A-Za-z0-9_$-]+)*\*\*/u;

interface LineBounds {
    readonly start: number;
    readonly end: number;
    readonly rawEnd: number;
    readonly nextLineStart: number;
}

export interface SourceIndex {
    readonly source: string;
    readonly lineCount: number;
    readonly lineIndexAt: (offset: number) => number;
    readonly lineBounds: (lineIndex: number) => LineBounds;
    readonly positionAt: (offset: number) => Position;
}

export const codePointCount = (slice: string): number => {
    let count = 0;
    for (let i = 0; i < slice.length; i += 1) {
        const cp = slice.codePointAt(i)!;
        if (cp > 0xffff) i += 1;
        count += 1;
    }
    return count;
};

export const createSourceIndex = (source: string): SourceIndex => {
    const lineOffsets: number[] = [0];
    for (let i = 0; i < source.length; i += 1) {
        if (source[i] === "\n") {
            lineOffsets.push(i + 1);
        }
    }

    const lineIndexAt = (offset: number): number => {
        const clamped = Math.max(0, Math.min(offset, source.length));
        let low = 0;
        let high = lineOffsets.length - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (lineOffsets[mid] <= clamped) low = mid + 1;
            else high = mid - 1;
        }
        return Math.max(0, high);
    };

    const lineBounds = (lineIndex: number): LineBounds => {
        const idx = Math.max(0, Math.min(lineIndex, lineOffsets.length - 1));
        const start = lineOffsets[idx];
        const hasNext = idx + 1 < lineOffsets.length;
        const rawEnd = hasNext ? lineOffsets[idx + 1] - 1 : source.length;
        const end = rawEnd > start && source[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
        const nextLineStart = hasNext ? lineOffsets[idx + 1] : source.length;
        return { start, end, rawEnd, nextLineStart };
    };

    const positionAt = (offset: number): Position => {
        const clamped = Math.max(0, Math.min(offset, source.length));
        const lineIndex = lineIndexAt(clamped);
        return {
            line: lineIndex + 1,
            column: codePointCount(source.slice(lineOffsets[lineIndex], clamped)),
        };
    };

    return {
        source,
        lineCount: lineOffsets.length,
        lineIndexAt,
        lineBounds,
        positionAt,
    };
};

export const readTrailingAside = (
    source: string,
    commentBodyStart: number,
): { readonly aside: string; readonly endOffset: number } => {
    const eol = source.indexOf("\n", commentBodyStart);
    const lineEnd = eol === -1 ? source.length : eol;
    const rawComment = source.slice(commentBodyStart, lineEnd);
    const glued = GLUED_TRANSCRIPT_HEADING.exec(rawComment);
    if (glued !== null) {
        return {
            aside: rawComment.slice(0, glued.index).replace(/\r$/u, "").trim(),
            endOffset: commentBodyStart + glued.index,
        };
    }
    return {
        aside: rawComment.replace(/\r$/u, "").trim(),
        endOffset: lineEnd,
    };
};
