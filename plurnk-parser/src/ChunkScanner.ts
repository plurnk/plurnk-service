import type { Position, RuntimeTag } from "@plurnk/plurnk-contracts";
import { findHeredocCloser, matchHeredocOpener } from "./HeredocSyntax.ts";
import {
    CODE_CONTINUATION_START,
    CODE_LINE_START,
    CONTAINS_CALL,
    translateToolCallsOutsideFences,
    unwrapCodeModeFences,
} from "./NativeEnvelopes.ts";
import { buildExecutorSpellings } from "./StatementLowering.ts";

export type Chunk =
    | { readonly kind: "code"; readonly text: string; readonly position: Position; readonly defaultAside: string | null }
    | { readonly kind: "text"; readonly text: string; readonly position: Position }
    | { readonly kind: "advisory"; readonly message: string; readonly position: Position };

// Split input into top-level Code Mode statement chunks, outside text paragraphs, and any truncated EOF tail.
export const scanChunks = (
    rawInput: string,
    tier: "model" | "statements" = "model",
    executorSpellings: ReadonlyMap<string, RuntimeTag> = buildExecutorSpellings(),
): {
    readonly chunks: readonly Chunk[];
    readonly unparsedTail?: { readonly from: Position; readonly reason: string };
} => {
    const { source: unwrappedSource, advisories } = unwrapCodeModeFences(
        rawInput,
        tier === "model" ? executorSpellings : undefined,
    );
    const source = tier === "model"
        ? translateToolCallsOutsideFences(unwrappedSource, executorSpellings)
        : unwrappedSource;
    const chunks: Chunk[] = [];
    const lines = source.split("\n");
    const lineOffsets: number[] = [];
    let acc = 0;
    for (const line of lines) {
        lineOffsets.push(acc);
        acc += line.length + 1;
    }

    const positionAt = (offset: number): Position => {
        let low = 0;
        let high = lineOffsets.length - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (lineOffsets[mid] <= offset) low = mid + 1;
            else high = mid - 1;
        }
        const lineIndex = Math.max(0, high);
        const slice = source.slice(lineOffsets[lineIndex], offset);
        return { line: lineIndex + 1, column: Array.from(slice).length };
    };

    let textLines: Array<{ readonly text: string; readonly lineIndex: number }> = [];
    const flushText = (): void => {
        if (textLines.length === 0) return;
        let start = 0;
        while (start < textLines.length && textLines[start].text.trim() === "") start += 1;
        let end = textLines.length - 1;
        while (end >= start && textLines[end].text.trim() === "") end -= 1;
        if (start <= end) {
            const firstLine = textLines[start];
            const firstTrimmed = firstLine.text.search(/\S/u);
            const content = textLines.slice(start, end + 1).map((l) => l.text.replace(/\r$/u, "")).join("\n");
            chunks.push({
                kind: "text",
                text: content,
                position: { line: firstLine.lineIndex + 1, column: firstTrimmed === -1 ? 0 : Array.from(firstLine.text.slice(0, firstTrimmed)).length },
            });
        }
        textLines = [];
    };

    let lineIdx = 0;
    let sameLineContinuation = false;
    while (lineIdx < lines.length) {
        const line = lines[lineIdx];
        const isContinuation = sameLineContinuation;
        sameLineContinuation = false;
        const trimmed = line.trim();
        if (trimmed === "") {
            if (textLines.length > 0) textLines.push({ text: line, lineIndex: lineIdx });
            lineIdx += 1;
            continue;
        }

        const fenceMatch = /^( {0,3})(`{3,}|~{3,})[ \t]*[^\n`~]*\r?$/u.exec(line);
        if (fenceMatch !== null) {
            const fence = fenceMatch[2];
            const fenceChar = fence[0];
            const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fence.length},}[ \\t]*\\r?$`, "u");
            const fenceStartLineIdx = lineIdx;
            const fenceLines: Array<{ readonly text: string; readonly lineIndex: number }> = [{ text: line, lineIndex: lineIdx }];
            lineIdx += 1;
            let closed = false;
            while (lineIdx < lines.length) {
                const fLine = lines[lineIdx];
                fenceLines.push({ text: fLine, lineIndex: lineIdx });
                lineIdx += 1;
                if (closeRe.test(fLine)) {
                    closed = true;
                    break;
                }
            }
            if (!closed) {
                flushText();
                for (const adv of advisories) {
                    chunks.push({ kind: "advisory", message: adv.message, position: adv.position });
                }
                return {
                    chunks,
                    unparsedTail: {
                        from: { line: fenceStartLineIdx + 1, column: fenceMatch[1].length },
                        reason: "Unterminated fenced block at end of input.",
                    },
                };
            }
            textLines.push(...fenceLines);
            continue;
        }

        if (!(isContinuation ? CODE_CONTINUATION_START : CODE_LINE_START).test(line)) {
            textLines.push({ text: line, lineIndex: lineIdx });
            lineIdx += 1;
            continue;
        }

        if (/^[ \t]*\/\//u.test(line)) {
            lineIdx += 1;
            continue;
        }

        const startOffset = lineOffsets[lineIdx] + line.search(/\S/u);
        const startPos = positionAt(startOffset);

        // Scan balanced statement from `startOffset`.
        let i = startOffset;
        let parenDepth = 0;
        let braceDepth = 0;
        let bracketDepth = 0;
        let openedCall = false;
        let inString: '"' | "'" | "`" | null = null;
        let inBlockComment = false;
        let inRegex = false;
        let inRegexClass = false;
        let unclosedHeredoc = false;
        const pendingTrailingHeredocs: string[] = [];
        let prevSigChar = "";
        let trailingAside: string | null = null;
        let codeEndOffset: number | null = null;

        while (i < source.length) {
            const ch = source[i];
            const next = source[i + 1];

            if (inBlockComment) {
                if (ch === "*" && next === "/") {
                    inBlockComment = false;
                    i += 2;
                    continue;
                }
                i += 1;
                continue;
            }

            if (inString !== null) {
                if (ch === "\\") {
                    i += 2;
                    continue;
                }
                if (ch === inString) {
                    inString = null;
                }
                i += 1;
                continue;
            }

            if (inRegex) {
                if (ch === "\\") {
                    i += 2;
                    continue;
                }
                if (ch === "[") inRegexClass = true;
                else if (ch === "]" && inRegexClass) inRegexClass = false;
                else if (ch === "/" && !inRegexClass) {
                    inRegex = false;
                    prevSigChar = "/";
                } else if (ch === "\n") {
                    inRegex = false;
                }
                i += 1;
                continue;
            }

            if (ch === "/" && next === "/") {
                const eol = source.indexOf("\n", i + 2);
                const commentText = (eol === -1 ? source.slice(i + 2) : source.slice(i + 2, eol)).replace(/\r$/u, "").trim();
                if (openedCall && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                    trailingAside = commentText;
                    i = eol === -1 ? source.length : eol;
                    break;
                }
                i = eol === -1 ? source.length : eol + 1;
                continue;
            }

            if (ch === "/" && next === "*") {
                inBlockComment = true;
                i += 2;
                continue;
            }

            if (ch === "<" && next === "<") {
                const opener = matchHeredocOpener(source, i);
                if (opener !== null) {
                    if (opener.isInline) {
                        const closer = findHeredocCloser(source, opener.bodyStart, opener.tag, "inline");
                        if (closer === null) {
                            unclosedHeredoc = true;
                            i = source.length;
                            break;
                        }
                        i = closer.afterTagOffset;
                        prevSigChar = '"';
                        continue;
                    }
                    pendingTrailingHeredocs.push(opener.tag);
                    i = opener.afterOpener;
                    prevSigChar = '"';
                    continue;
                }
            }

            if (ch === '"' || ch === "'" || ch === "`") {
                inString = ch;
                i += 1;
                continue;
            }

            if (ch === "/" && (prevSigChar === "" || "([{:;,=!&|?~+-*%^<>".includes(prevSigChar))) {
                inRegex = true;
                inRegexClass = false;
                i += 1;
                continue;
            }

            if (ch === "(") {
                if (prevSigChar !== "") {
                    parenDepth += 1;
                    openedCall = true;
                    prevSigChar = ch;
                }
                i += 1;
                continue;
            }
            if (ch === ")") {
                if (parenDepth > 0) parenDepth -= 1;
                prevSigChar = ch;
                i += 1;
                if (openedCall && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                    while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\r" || source[i] === "}" || source[i] === ")")) i += 1;
                    if (source[i] === ";" || (source[i] === "." && /^[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(source.slice(i + 1)))) {
                        i += 1;
                        while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\r")) i += 1;
                    }
                    if (source[i] === "/" && source[i + 1] === "/") {
                        const eol = source.indexOf("\n", i + 2);
                        trailingAside = (eol === -1 ? source.slice(i + 2) : source.slice(i + 2, eol)).replace(/\r$/u, "").trim();
                        i = eol === -1 ? source.length : eol;
                    } else if (pendingTrailingHeredocs.length === 0 && source[i] === "<" && source[i + 1] === "<") {
                        const attachedOpener = matchHeredocOpener(source, i);
                        if (attachedOpener !== null) {
                            const nl = source.indexOf("\n", attachedOpener.afterOpener);
                            if (nl === -1 || source.slice(attachedOpener.afterOpener).trim() === "") {
                                codeEndOffset = i;
                                i = source.length;
                            } else {
                                const closer = findHeredocCloser(source, nl + 1, attachedOpener.tag, "trailing");
                                if (closer !== null) {
                                    codeEndOffset = i;
                                    const asideBody = closer.body.trim();
                                    if (asideBody.length > 0) trailingAside = asideBody.replaceAll(/\r?\n/gu, " ");
                                    i = closer.lineEndOffset;
                                }
                            }
                        }
                    }
                    break;
                }
                continue;
            }
            if (ch === "{") {
                braceDepth += 1;
                prevSigChar = ch;
                i += 1;
                continue;
            }
            if (ch === "}") {
                const prematureObjectClose = braceDepth === 1 && parenDepth === 1 && bracketDepth === 0
                    && /^\}[ \t\r\n]*[,;][ \t\r\n]*(?=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z0-9_$-]+)[ \t\r\n]*\??[ \t\r\n]*:)/u.test(source.slice(i));
                if (!prematureObjectClose) {
                    if (braceDepth > 0) braceDepth -= 1;
                    else if (openedCall && parenDepth === 1 && bracketDepth === 0 && /^;?[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(source.slice(i + 1))) parenDepth = 0;
                }
                prevSigChar = ch;
                i += 1;
                if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
                    if (openedCall) {
                        while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\r" || source[i] === "}" || source[i] === ")")) i += 1;
                        if (source[i] === ";" || (source[i] === "." && /^[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(source.slice(i + 1)))) {
                            i += 1;
                            while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\r")) i += 1;
                        }
                        if (source[i] === "/" && source[i + 1] === "/") {
                            const eol = source.indexOf("\n", i + 2);
                            trailingAside = (eol === -1 ? source.slice(i + 2) : source.slice(i + 2, eol)).replace(/\r$/u, "").trim();
                            i = eol === -1 ? source.length : eol;
                        }
                    }
                    break;
                }
                continue;
            }
            if (ch === "[") {
                bracketDepth += 1;
                prevSigChar = ch;
                i += 1;
                continue;
            }
            if (ch === "]") {
                if (bracketDepth > 0) bracketDepth -= 1;
                prevSigChar = ch;
                i += 1;
                continue;
            }
            if (ch === ";" && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                i += 1;
                while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\r")) i += 1;
                if (source[i] === "/" && source[i + 1] === "/") {
                    const eol = source.indexOf("\n", i + 2);
                    trailingAside = (eol === -1 ? source.slice(i + 2) : source.slice(i + 2, eol)).replace(/\r$/u, "").trim();
                    i = eol === -1 ? source.length : eol;
                }
                break;
            }
            if (ch === "\n" && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                if (openedCall || prevSigChar !== ".") {
                    break;
                }
            }
            if (!/\s/u.test(ch)) {
                prevSigChar = ch;
            }
            i += 1;
        }

        if (
            pendingTrailingHeredocs.length > 0
            && !unclosedHeredoc
            && inString === null
            && !inBlockComment
            && parenDepth === 0
            && braceDepth === 0
            && bracketDepth === 0
        ) {
            while (pendingTrailingHeredocs.length > 0) {
                const nextTag = pendingTrailingHeredocs.shift()!;
                const nl = source.indexOf("\n", i);
                if (nl === -1) {
                    unclosedHeredoc = true;
                    i = source.length;
                    break;
                }
                const closer = findHeredocCloser(source, nl + 1, nextTag, "trailing");
                if (closer === null) {
                    unclosedHeredoc = true;
                    i = source.length;
                    break;
                }
                if (trailingAside === null && closer.trailingComment !== null) {
                    trailingAside = closer.trailingComment;
                }
                i = closer.lineEndOffset;
            }
        }

        const chunkText = source.slice(startOffset, codeEndOffset ?? i);
        const unclosed = unclosedHeredoc || pendingTrailingHeredocs.length > 0 || inString !== null || inBlockComment || parenDepth > 0 || braceDepth > 0 || bracketDepth > 0
            || (!openedCall && /^(?:await\s+[A-Za-z_$][A-Za-z0-9_$.]*|plurnk(?:\.[A-Za-z0-9_$]*)?)$/u.test(chunkText.trim()));

        if (unclosed && i >= source.length) {
            flushText();
            for (const adv of advisories) {
                chunks.push({ kind: "advisory", message: adv.message, position: adv.position });
            }
            return {
                chunks,
                unparsedTail: {
                    from: startPos,
                    reason: "Unterminated Code Mode statement at end of input.",
                },
            };
        }

        if (!CONTAINS_CALL.test(chunkText) && !/^(?:await\s+)?plurnk\b/u.test(chunkText.trim())) {
            textLines.push({ text: line, lineIndex: lineIdx });
            lineIdx += 1;
            continue;
        }

        flushText();
        chunks.push({
            kind: "code",
            text: chunkText,
            position: startPos,
            defaultAside: trailingAside !== null && trailingAside.length > 0 ? trailingAside : null,
        });

        const nextNewline = source.indexOf("\n", i);
        const lineEnd = nextNewline === -1 ? source.length : nextNewline;
        const remainderOnLine = source.slice(i, lineEnd).trim();
        if (remainderOnLine.length > 0) {
            const targetLineIdx = positionAt(i).line - 1;
            const lineStart = lineOffsets[targetLineIdx];
            const consumedCols = i - lineStart;
            lines[targetLineIdx] = " ".repeat(consumedCols) + lines[targetLineIdx].slice(consumedCols);
            lineIdx = targetLineIdx;
            sameLineContinuation = true;
        } else if (nextNewline === -1) {
            break;
        } else {
            lineIdx = positionAt(nextNewline).line;
        }
    }

    flushText();
    for (const adv of advisories) {
        chunks.push({ kind: "advisory", message: adv.message, position: adv.position });
    }
    return { chunks };
};
