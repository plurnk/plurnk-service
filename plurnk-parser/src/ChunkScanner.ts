import { isRecord, type Position, type RuntimeTag } from "@plurnk/plurnk-contracts";
import { hasSiblingCallAfterEol, isLikelyObjectValueStringClose, parseCallStatements } from "./CallExpressionParser.ts";
import { BUILTIN_STANDALONE_EXECUTORS } from "./CodeSerializer.ts";
import { decodeWrapperWholePayload, scanEnvelopeAt } from "./EnvelopeScanner.ts";
import { findHeredocCloser, matchHeredocOpener } from "./HeredocSyntax.ts";
import { CORE_OP_MAP, type ParsedCall } from "./OptionCoercion.ts";
import { createSourceIndex, readTrailingAside } from "./SourceIndex.ts";
import { buildExecutorSpellings } from "./StatementLowering.ts";
import { decodeJsonOrValueCalls, hasFencedCodeModeCall } from "./TargetResolver.ts";

const CODE_LINE_START = /^ {0,3}(?:\(+\s*(?:await\s+[A-Za-z_$]|plurnk\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])?\s*(?:[(;]|\/\/|\/\*|\r?$)|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\()|await\s+[A-Za-z_$(]|plurnk\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])?\s*(?:[(;]|\/\/|\/\*|\r?$)|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(|(?:const|let|var|for|while|if|switch|try|function)\b|\/\/|\/\*)/u;

const CODE_CONTINUATION_START = /^[ \t]*(?:\(+\s*(?:await\s+[A-Za-z_$]|plurnk\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])?\s*(?:[(;]|\/\/|\/\*|\r?$)|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\()|await\s+[A-Za-z_$(]|plurnk\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])?\s*(?:[(;]|\/\/|\/\*|\r?$)|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(|(?:const|let|var|for|while|if|switch|try|function)\b|\/\/|\/\*)/u;

const CONTAINS_CALL = /\bplurnk\s*(?:\.|\[|\()|\bawait\s+[A-Za-z_$][A-Za-z0-9_$-]*\s*\(|(?:await\s+)?[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(/u;

const trimLineBreakBefore = (source: string, offset: number): number => {
    if (offset > 0 && source[offset - 1] === "\n") {
        return offset >= 2 && source[offset - 2] === "\r" ? offset - 2 : offset - 1;
    }
    return offset;
};

const isModelCodeChunk = (
    chunkText: string,
    startPos: Position,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
): boolean => {
    const trimmedChunk = chunkText.trim();
    if (/^(?:\(+\s*)?(?:await\s+[A-Za-z_$(]|plurnk\b)/iu.test(trimmedChunk)) {
        return true;
    }
    const headMatch = /^(?:\(+\s*)?([A-Za-z_$][A-Za-z0-9_$-]*)\s*(?:\.|\[|\()/u.exec(trimmedChunk);
    if (headMatch !== null) {
        const headLower = headMatch[1].toLowerCase();
        if (
            headLower === "plurnk"
            || executorSpellings.has(headMatch[1])
            || executorSpellings.has(headLower)
            || CORE_OP_MAP.has(headLower)
        ) {
            return true;
        }
    }
    if (/^(?:const|let|var|for|while|if|switch|try|function)\b/u.test(trimmedChunk)) {
        if (/\bplurnk\b/iu.test(trimmedChunk)) return true;
        for (const m of trimmedChunk.matchAll(/\b(?:(await)\s+)?([A-Za-z_$][A-Za-z0-9_$-]*)\s*(\.|\[|\()/gu)) {
            const hasAwait = m[1] !== undefined;
            const target = m[2];
            const targetLower = target.toLowerCase();
            const afterTarget = trimmedChunk.slice(m.index + m[0].length - 1);
            if (hasAwait) {
                if (
                    targetLower === "plurnk"
                    || executorSpellings.has(target)
                    || executorSpellings.has(targetLower)
                    || CORE_OP_MAP.has(targetLower)
                ) {
                    return true;
                }
                if (/^(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'`][^"'`]+["'`]\s*\])\s*\(\s*\{/u.test(afterTarget)) {
                    return true;
                }
            } else {
                const mappedRuntime = executorSpellings.get(targetLower);
                if (
                    mappedRuntime !== undefined
                    && !BUILTIN_STANDALONE_EXECUTORS.has(mappedRuntime)
                    && /^(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'`][^"'`]+["'`]\s*\])\s*\(\s*\{/u.test(afterTarget)
                ) {
                    return true;
                }
            }
        }
        return false;
    }
    try {
        const calls = parseCallStatements(chunkText, startPos, "model");
        return calls.length > 0 && calls.every((c) => c.args.length > 0 && c.args.every((a) => isRecord(a)));
    } catch {
        return false;
    }
};

export type Chunk =
    | {
        readonly kind: "code";
        readonly text: string;
        readonly position: Position;
        readonly defaultAside: string | null;
    }
    | {
        readonly kind: "calls";
        readonly calls: readonly ParsedCall[];
        readonly attemptText: string;
        readonly position: Position;
        readonly defaultAside: string | null;
    }
    | {
        readonly kind: "text";
        readonly text: string;
        readonly position: Position;
    };

export interface ScanChunksResult {
    readonly chunks: readonly Chunk[];
    readonly unparsedTail?: { readonly from: Position; readonly reason: string };
}

// Single-pass character-indexed scanner partitioning raw input into Code Mode statement chunks, decoded RENO call chunks, outside prose, and any truncated EOF tail.
export const scanChunks = (
    rawInput: string,
    tier: "model" | "statements" = "model",
    executorSpellings: ReadonlyMap<string, RuntimeTag> = buildExecutorSpellings(),
): ScanChunksResult => {
    const index = createSourceIndex(rawInput);
    const wrapperCache = new Map<string, readonly Chunk[] | null>();

    const tryDecodeWrapper = (
        innerStart: number,
        innerEnd: number,
        defaultService?: string,
        isResultWrapper = false,
        isSystem = false,
    ): readonly Chunk[] | null => {
        const cacheKey = `${innerStart}:${innerEnd}:${defaultService ?? ""}:${isResultWrapper ? 1 : 0}:${isSystem ? 1 : 0}`;
        if (wrapperCache.has(cacheKey)) {
            return wrapperCache.get(cacheKey) ?? null;
        }
        // Guard against recursive self-reference on identical span.
        wrapperCache.set(cacheKey, null);

        if (!isSystem) {
            const whole = decodeWrapperWholePayload(
                rawInput,
                innerStart,
                innerEnd,
                index.positionAt(innerStart),
                executorSpellings,
                defaultService,
                isResultWrapper,
            );
            if (whole !== null) {
                const pos = index.positionAt(innerStart);
                const result: readonly Chunk[] = whole.kind === "calls"
                    ? [{
                        kind: "calls",
                        calls: whole.calls,
                        attemptText: rawInput.slice(innerStart, innerEnd).trim(),
                        position: pos,
                        defaultAside: null,
                    }]
                    : [{
                        kind: "code",
                        text: whole.text,
                        position: pos,
                        defaultAside: null,
                    }];
                wrapperCache.set(cacheKey, result);
                return result;
            }
        }

        const sub = scanSpan(innerStart, innerEnd, defaultService);
        const hasExecutable = sub.chunks.some((c) => c.kind === "code" || c.kind === "calls");
        const result = hasExecutable ? sub.chunks : null;
        wrapperCache.set(cacheKey, result);
        return result;
    };

    const canDecodeWrapperSpan = (
        innerStart: number,
        innerEnd: number,
        defaultService?: string,
        isResultWrapper = false,
        isSystem = false,
    ): boolean => tryDecodeWrapper(innerStart, innerEnd, defaultService, isResultWrapper, isSystem) !== null;

    const scanSpan = (
        spanStart: number,
        spanEnd: number,
        defaultService?: string,
    ): ScanChunksResult => {
        const spanSource = spanEnd === rawInput.length ? rawInput : rawInput.slice(0, spanEnd);
        const chunks: Chunk[] = [];
        let pendingTextLines: Array<{ readonly text: string; readonly firstNonWsOffset: number }> = [];

        const flushText = (): void => {
            if (pendingTextLines.length === 0) return;
            let start = 0;
            while (start < pendingTextLines.length && pendingTextLines[start].text.trim() === "") start += 1;
            let end = pendingTextLines.length - 1;
            while (end >= start && pendingTextLines[end].text.trim() === "") end -= 1;
            if (start <= end) {
                const kept = pendingTextLines.slice(start, end + 1);
                chunks.push({
                    kind: "text",
                    text: kept.map((l) => l.text).join("\n"),
                    position: index.positionAt(kept[0].firstNonWsOffset),
                });
            }
            pendingTextLines = [];
        };

        const firstNonWsInRange = (from: number, to: number): number => {
            const rel = rawInput.slice(from, to).search(/\S/u);
            return rel === -1 ? from : from + rel;
        };

        let cursor = spanStart;
        let sameLineContinuation = false;

        const advanceAfterItem = (itemStart: number, rawEndOffset: number): void => {
            const clampedEnd = Math.min(rawEndOffset, spanEnd);
            if (clampedEnd >= spanEnd) {
                cursor = spanEnd;
                sameLineContinuation = false;
                return;
            }
            const endLineIdx = index.lineIndexAt(clampedEnd);
            const endLb = index.lineBounds(endLineIdx);
            if (clampedEnd === endLb.start && clampedEnd > itemStart) {
                cursor = clampedEnd;
                sameLineContinuation = false;
                return;
            }
            const endLineLimit = Math.min(endLb.end, spanEnd);
            if (rawInput.slice(clampedEnd, endLineLimit).trim().length > 0) {
                cursor = clampedEnd;
                sameLineContinuation = true;
            } else {
                cursor = Math.min(endLb.nextLineStart, spanEnd);
                sameLineContinuation = false;
            }
        };

        while (cursor < spanEnd) {
            const lineIdx = index.lineIndexAt(cursor);
            const lb = index.lineBounds(lineIdx);
            const lineEnd = Math.min(lb.end, spanEnd);
            const nextLineStart = Math.min(lb.nextLineStart, spanEnd);
            const atLineStart = cursor === lb.start;
            const isContinuation = sameLineContinuation;
            sameLineContinuation = false;

            const lineSlice = rawInput.slice(cursor, lineEnd);
            if (lineSlice.trim() === "") {
                if (atLineStart && pendingTextLines.length > 0) {
                    pendingTextLines.push({ text: "", firstNonWsOffset: cursor });
                }
                if (nextLineStart <= cursor) break;
                cursor = nextLineStart;
                continue;
            }

            // 1. Top-level Markdown fences & Cohere `Action: ```json` blocks.
            if (atLineStart && !isContinuation) {
                const cohereMatch = tier === "model"
                    ? /^( {0,3})Action:[ \t]*(`{3,}|~{3,})([^\n`~]*)$/iu.exec(lineSlice)
                    : null;
                const stdFenceMatch = cohereMatch === null
                    ? /^( {0,3})(`{3,}|~{3,})([ \t]*[^\n`~]*)$/u.exec(lineSlice)
                    : null;
                const openMatch = cohereMatch ?? stdFenceMatch;

                if (openMatch !== null) {
                    const fence = openMatch[2];
                    const fenceChar = fence[0];
                    const infoString = openMatch[3];
                    const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fence.length},}[ \\t]*$`, "u");

                    let closeLineIdx = -1;
                    for (let j = lineIdx + 1; j < index.lineCount; j += 1) {
                        const lbJ = index.lineBounds(j);
                        if (lbJ.start >= spanEnd) break;
                        const fLine = rawInput.slice(lbJ.start, Math.min(lbJ.end, spanEnd));
                        if (closeRe.test(fLine)) {
                            closeLineIdx = j;
                            break;
                        }
                    }

                    if (closeLineIdx === -1) {
                        if (
                            tier === "model"
                            && cohereMatch === null
                            && infoString.trim() === ""
                            && rawInput.slice(nextLineStart, spanEnd).trim() === ""
                            && chunks.some((c) => c.kind === "code" || c.kind === "calls")
                        ) {
                            cursor = spanEnd;
                            break;
                        }
                        flushText();
                        return {
                            chunks,
                            unparsedTail: {
                                from: { line: lineIdx + 1, column: openMatch[1].length },
                                reason: "Unterminated fenced block at end of input.",
                            },
                        };
                    }

                    const closeLb = index.lineBounds(closeLineIdx);
                    const innerStart = nextLineStart;
                    const innerEnd = closeLb.start > innerStart ? trimLineBreakBefore(rawInput, closeLb.start) : innerStart;

                    if (cohereMatch !== null) {
                        const jsonCalls = decodeJsonOrValueCalls(
                            rawInput.slice(innerStart, innerEnd),
                            executorSpellings,
                            index.positionAt(innerStart),
                            defaultService,
                        );
                        if (jsonCalls !== null) {
                            flushText();
                            chunks.push({
                                kind: "calls",
                                calls: jsonCalls,
                                attemptText: rawInput.slice(innerStart, innerEnd).trim(),
                                position: index.positionAt(innerStart),
                                defaultAside: null,
                            });
                            cursor = Math.min(closeLb.nextLineStart, spanEnd);
                            continue;
                        }
                    } else {
                        const lang = (infoString.trim().split(/\s+/u)[0] ?? "").toLowerCase();
                        const isCodeModeLang = lang === ""
                            || lang === "ts"
                            || lang === "tsx"
                            || lang === "js"
                            || lang === "jsx"
                            || lang === "typescript"
                            || lang === "javascript"
                            || lang === "plurnk";
                        const inner = rawInput.slice(innerStart, innerEnd);
                        const hasNestedFence = /^ {0,3}(?:`{3,}|~{3,})/mu.test(inner);
                        if (isCodeModeLang && !hasNestedFence && hasFencedCodeModeCall(inner, executorSpellings)) {
                            flushText();
                            const sub = scanSpan(innerStart, innerEnd, defaultService);
                            chunks.push(...sub.chunks);
                            cursor = Math.min(closeLb.nextLineStart, spanEnd);
                            continue;
                        }
                    }

                    for (let j = lineIdx; j <= closeLineIdx; j += 1) {
                        const lbJ = index.lineBounds(j);
                        const jEnd = Math.min(lbJ.end, spanEnd);
                        pendingTextLines.push({
                            text: rawInput.slice(lbJ.start, jEnd),
                            firstNonWsOffset: firstNonWsInRange(lbJ.start, jEnd),
                        });
                    }
                    cursor = Math.min(closeLb.nextLineStart, spanEnd);
                    continue;
                }
            }

            const relNonWs = lineSlice.search(/\S/u);
            const nonWsOffset = cursor + relNonWs;

            // 2. Foreign RENO envelope / control-token trivia check at `nonWsOffset`.
            if (tier === "model") {
                if (
                    atLineStart
                    && !isContinuation
                    && spanSource[nonWsOffset] === "`"
                    && spanSource[nonWsOffset + 1] !== "`"
                ) {
                    const restLine = spanSource.slice(nonWsOffset + 1, lineEnd);
                    if (
                        /^(?:await\s+)?plurnk\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(\s*\{/u.test(restLine)
                        && (
                            /<<<[ \t]*['"]?[A-Za-z_][A-Za-z0-9_-]*['"]?[ \t]*$/u.test(restLine)
                            || /\}[ \t]*\)[ \t]*;?[ \t]*`?[ \t]*;?(?:[ \t]*\/\/[^\r\n]*)?$/u.test(restLine)
                        )
                    ) {
                        cursor = nonWsOffset + 1;
                        sameLineContinuation = true;
                        continue;
                    }
                }
                const env = scanEnvelopeAt(
                    spanSource,
                    nonWsOffset,
                    atLineStart && !isContinuation,
                    index,
                    executorSpellings,
                    canDecodeWrapperSpan,
                    defaultService,
                );
                if (env !== null) {
                    if (env.kind === "trivia") {
                        advanceAfterItem(nonWsOffset, env.endOffset);
                        continue;
                    }
                    if (env.kind === "unwrap-prefix") {
                        cursor = Math.min(env.innerOffset, spanEnd);
                        sameLineContinuation = true;
                        continue;
                    }
                    if (env.kind === "unwrap-span") {
                        const decoded = tryDecodeWrapper(
                            env.innerStart,
                            env.innerEnd,
                            env.defaultService ?? defaultService,
                            false,
                            env.isSystem === true,
                        );
                        if (decoded !== null) {
                            flushText();
                            chunks.push(...decoded);
                            advanceAfterItem(nonWsOffset, env.endOffset);
                            continue;
                        }
                    } else if (env.kind === "calls") {
                        flushText();
                        chunks.push({
                            kind: "calls",
                            calls: env.calls,
                            attemptText: env.attemptText,
                            position: env.position,
                            defaultAside: env.defaultAside,
                        });
                        advanceAfterItem(nonWsOffset, env.endOffset);
                        continue;
                    } else if (env.kind === "code") {
                        flushText();
                        chunks.push({
                            kind: "code",
                            text: env.text,
                            position: env.position,
                            defaultAside: env.defaultAside,
                        });
                        advanceAfterItem(nonWsOffset, env.endOffset);
                        continue;
                    }
                }
            }

            // 3. Prose line (with mid-line envelope island detection outside inline backtick spans).
            if (!(isContinuation ? CODE_CONTINUATION_START : CODE_LINE_START).test(lineSlice)) {
                if (tier === "model") {
                    let p = nonWsOffset + 1;
                    let splitAt = -1;
                    while (p < lineEnd) {
                        const ch = spanSource[p];
                        if (ch === "`") {
                            let tickLen = 1;
                            while (p + tickLen < lineEnd && spanSource[p + tickLen] === "`") tickLen += 1;
                            const closeTicks = "`".repeat(tickLen);
                            const closeIdx = spanSource.slice(p + tickLen, lineEnd).indexOf(closeTicks);
                            if (closeIdx !== -1) {
                                p = p + tickLen + closeIdx + tickLen;
                                continue;
                            }
                            p += tickLen;
                            continue;
                        }
                        if (ch === "<" || ch === "[") {
                            const midEnv = scanEnvelopeAt(
                                spanSource,
                                p,
                                false,
                                index,
                                executorSpellings,
                                canDecodeWrapperSpan,
                                defaultService,
                            );
                            if (
                                midEnv !== null
                                && (
                                    midEnv.kind !== "unwrap-span"
                                    || tryDecodeWrapper(
                                        midEnv.innerStart,
                                        midEnv.innerEnd,
                                        midEnv.defaultService ?? defaultService,
                                        false,
                                        midEnv.isSystem === true,
                                    ) !== null
                                )
                            ) {
                                splitAt = p;
                                break;
                            }
                        }
                        p += 1;
                    }
                    if (splitAt !== -1) {
                        const prefixRaw = rawInput.slice(cursor, splitAt);
                        if (prefixRaw.trim().length > 0) {
                            pendingTextLines.push({
                                text: isContinuation ? prefixRaw.trimStart() : prefixRaw,
                                firstNonWsOffset: nonWsOffset,
                            });
                        }
                        cursor = splitAt;
                        sameLineContinuation = true;
                        continue;
                    }
                }

                pendingTextLines.push({
                    text: isContinuation ? lineSlice.trimStart() : lineSlice,
                    firstNonWsOffset: nonWsOffset,
                });
                if (nextLineStart <= cursor) break;
                cursor = nextLineStart;
                continue;
            }

            // Top-level standalone `//` comment lines are ignored.
            if (/^[ \t]*\/\//u.test(lineSlice)) {
                if (nextLineStart <= cursor) break;
                cursor = nextLineStart;
                continue;
            }

            // 4. Balanced Code Mode statement scan from `startOffset` within `spanSource`.
            const startOffset = nonWsOffset;
            const startPos = index.positionAt(startOffset);

            let i = startOffset;
            let parenDepth = 0;
            let braceDepth = 0;
            let bracketDepth = 0;
            let openedCall = false;
            let inString: '"' | "'" | "`" | null = null;
            let inEscapedString: '"' | "'" | null = null;
            let inObjectValue = false;
            let inBlockComment = false;
            let inRegex = false;
            let inRegexClass = false;
            let unclosedHeredoc = false;
            let onInlineHeredocCloserLine = false;
            const pendingTrailingHeredocs: string[] = [];
            let prevSigChar = "";
            let trailingAside: string | null = null;
            let codeEndOffset: number | null = null;

            while (i < spanSource.length) {
                const ch = spanSource[i];
                const next = spanSource[i + 1];

                if (inBlockComment) {
                    if (ch === "*" && next === "/") {
                        inBlockComment = false;
                        i += 2;
                        continue;
                    }
                    i += 1;
                    continue;
                }

                if (inEscapedString !== null) {
                    if (ch === "\\" && next === "\\" && spanSource[i + 2] === inEscapedString) {
                        i += 3;
                        continue;
                    }
                    if (ch === "\\" && next === inEscapedString) {
                        prevSigChar = inEscapedString;
                        inEscapedString = null;
                        i += 2;
                        continue;
                    }
                    if (ch === "\\") {
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
                        if (
                            tier === "model"
                            && inObjectValue
                            && bracketDepth === 0
                            && (inString === '"' || inString === "'")
                            && !isLikelyObjectValueStringClose(spanSource, i, inString, executorSpellings)
                        ) {
                            i += 1;
                            continue;
                        }
                        prevSigChar = ch;
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
                    if (openedCall && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                        const { aside, endOffset } = readTrailingAside(spanSource, i + 2);
                        trailingAside = aside;
                        i = endOffset;
                        break;
                    }
                    const eol = spanSource.indexOf("\n", i + 2);
                    i = eol === -1 ? spanSource.length : eol + 1;
                    continue;
                }

                if (ch === "/" && next === "*") {
                    inBlockComment = true;
                    i += 2;
                    continue;
                }

                if (ch === "<" && next === "<") {
                    const opener = matchHeredocOpener(spanSource, i, {
                        allowQuotedWrapper: tier === "model",
                        allowEmptyInline: tier === "model",
                    });
                    if (opener !== null) {
                        if (opener.isEmptyInline === true) {
                            i = opener.afterOpener;
                            inObjectValue = false;
                            prevSigChar = '"';
                            continue;
                        }
                        if (opener.isInline) {
                            const closer = findHeredocCloser(spanSource, opener.bodyStart, opener.tag, "inline", {
                                outerQuote: opener.outerQuote ?? null,
                                allowMalformedRecovery: tier === "model" && (opener.outerQuote ?? null) === null,
                            });
                            if (closer === null) {
                                unclosedHeredoc = true;
                                i = spanSource.length;
                                break;
                            }
                            i = closer.afterTagOffset;
                            onInlineHeredocCloserLine = true;
                            inObjectValue = false;
                            prevSigChar = '"';
                            continue;
                        }
                        pendingTrailingHeredocs.push(opener.tag);
                        i = opener.afterOpener;
                        inObjectValue = false;
                        prevSigChar = '"';
                        continue;
                    }
                }

                if (tier === "model" && ch === "\\" && (next === '"' || next === "'")) {
                    inEscapedString = next;
                    prevSigChar = next;
                    i += 2;
                    continue;
                }

                if (ch === '"' || ch === "'" || ch === "`") {
                    if (
                        tier === "model"
                        && (ch === '"' || ch === "'")
                        && next === "<"
                        && spanSource[i + 2] === "<"
                    ) {
                        const qOpener = matchHeredocOpener(spanSource, i, { allowQuotedWrapper: true });
                        if (qOpener !== null) {
                            const qCloser = findHeredocCloser(spanSource, qOpener.bodyStart, qOpener.tag, "inline", {
                                outerQuote: qOpener.outerQuote ?? null,
                                allowMalformedRecovery: false,
                            });
                            if (qCloser !== null) {
                                i = qCloser.afterTagOffset;
                                onInlineHeredocCloserLine = true;
                                inObjectValue = false;
                                prevSigChar = '"';
                                continue;
                            }
                        }
                    }

                    // Stray half-quoted object property key (`{path": "g.ts"}` or `{items":[...`).
                    if (
                        tier === "model"
                        && (ch === '"' || ch === "'")
                        && braceDepth > 0
                        && !inObjectValue
                        && /[{,;][ \t\r\n]*[A-Za-z0-9_$-]+$/u.test(spanSource.slice(Math.max(startOffset, i - 48), i))
                        && /^[ \t]*\??[ \t]*:/u.test(spanSource.slice(i + 1))
                    ) {
                        i += 1;
                        continue;
                    }

                    if (
                        (openedCall && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0 && prevSigChar === "}" && /^[ \t]*\)/u.test(spanSource.slice(i + 1)))
                        || (tier === "model" && openedCall && parenDepth === 1 && braceDepth === 1 && bracketDepth === 0 && prevSigChar === '"' && (ch === '"' || ch === "'") && /^[ \t]*\}[ \t]*\)/u.test(spanSource.slice(i + 1)))
                    ) {
                        i += 1;
                        continue;
                    }
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

                if (ch === ":" && braceDepth > 0 && bracketDepth === 0) {
                    inObjectValue = true;
                    prevSigChar = ch;
                    i += 1;
                    continue;
                }
                if (ch === "," && braceDepth > 0 && bracketDepth === 0) {
                    inObjectValue = false;
                    prevSigChar = ch;
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
                    if (
                        tier === "model"
                        && openedCall
                        && parenDepth === 0
                        && braceDepth === 1
                        && bracketDepth === 0
                    ) {
                        const afterParen = spanSource.slice(i);
                        const omittedObjectClose = /^[ \t]*;?[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(afterParen)
                            && (
                                onInlineHeredocCloserLine
                                || pendingTrailingHeredocs.length > 0
                                || !/^[ \t]*;?[ \t\r]*(?:\/\/[^\n]*)?\n(?:[ \t\r\n]|\/\/[^\n]*\n)*[},]/u.test(afterParen)
                            );
                        if (omittedObjectClose) {
                            braceDepth = 0;
                        }
                    }
                    if (openedCall && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                        while (
                            i < spanSource.length
                            && (
                                spanSource[i] === " "
                                || spanSource[i] === "\t"
                                || spanSource[i] === "\r"
                                || spanSource[i] === "}"
                                || spanSource[i] === ")"
                                || spanSource[i] === "]"
                                || ((spanSource[i] === "'" || spanSource[i] === '"' || spanSource[i] === "`") && /^[)\]; \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(spanSource.slice(i + 1)))
                            )
                        ) {
                            i += 1;
                        }
                        if (spanSource[i] === ";" || (spanSource[i] === "." && /^[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(spanSource.slice(i + 1)))) {
                            i += 1;
                            while (i < spanSource.length && (spanSource[i] === " " || spanSource[i] === "\t" || spanSource[i] === "\r")) i += 1;
                        }
                        if (tier === "model" && spanSource[i] === "`" && /^[ \t\r;]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(spanSource.slice(i + 1))) {
                            i += 1;
                            while (i < spanSource.length && (spanSource[i] === " " || spanSource[i] === "\t" || spanSource[i] === "\r" || spanSource[i] === ";")) i += 1;
                        }
                        if (spanSource[i] === "/" && spanSource[i + 1] === "/") {
                            const { aside, endOffset } = readTrailingAside(spanSource, i + 2);
                            trailingAside = aside;
                            i = endOffset;
                        } else if (pendingTrailingHeredocs.length === 0 && spanSource[i] === "<" && spanSource[i + 1] === "<") {
                            const attachedOpener = matchHeredocOpener(spanSource, i);
                            if (attachedOpener !== null) {
                                const nl = spanSource.indexOf("\n", attachedOpener.afterOpener);
                                if (nl === -1 || spanSource.slice(attachedOpener.afterOpener).trim() === "") {
                                    codeEndOffset = i;
                                    i = spanSource.length;
                                } else {
                                    const closer = findHeredocCloser(spanSource, nl + 1, attachedOpener.tag, "trailing", {
                                        allowMalformedRecovery: false,
                                    });
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
                if (tier === "model" && (ch === "{" || ch === "[")) {
                    const wrappedHeredoc = /^(?:[{[][ \t]*)*\{[ \t]*(?:[{[][ \t]*)*(?=<<<?-?['"]?[A-Za-z])/u.exec(spanSource.slice(i));
                    if (wrappedHeredoc !== null) {
                        const candidatePos = i + wrappedHeredoc[0].length;
                        const wOpener = matchHeredocOpener(spanSource, candidatePos, { allowEmptyInline: true });
                        if (wOpener !== null && wOpener.isInline) {
                            const wCloser = wOpener.isEmptyInline === true
                                ? { afterTagOffset: wOpener.afterOpener }
                                : findHeredocCloser(spanSource, wOpener.bodyStart, wOpener.tag, "inline", { allowMalformedRecovery: true });
                            if (wCloser !== null) {
                                let afterClose = wCloser.afterTagOffset;
                                let consumedBrace = false;
                                while (afterClose < spanSource.length && (spanSource[afterClose] === " " || spanSource[afterClose] === "\t")) afterClose += 1;
                                while (afterClose < spanSource.length && (spanSource[afterClose] === "}" || spanSource[afterClose] === "]")) {
                                    if (spanSource[afterClose] === "}") consumedBrace = true;
                                    afterClose += 1;
                                    while (afterClose < spanSource.length && (spanSource[afterClose] === " " || spanSource[afterClose] === "\t")) afterClose += 1;
                                }
                                if (consumedBrace && braceDepth > 0 && spanSource[afterClose] === ")") {
                                    braceDepth -= 1;
                                }
                                i = afterClose;
                                onInlineHeredocCloserLine = true;
                                inObjectValue = false;
                                prevSigChar = '"';
                                continue;
                            }
                        }
                    }
                }
                if (ch === "{") {
                    braceDepth += 1;
                    inObjectValue = false;
                    prevSigChar = ch;
                    i += 1;
                    continue;
                }
                if (ch === "}") {
                    inObjectValue = false;
                    const prematureObjectClose = braceDepth === 1 && parenDepth === 1 && bracketDepth === 0
                        && /^\}[ \t\r\n]*[,;][ \t\r\n]*(?=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\\"(?:[^"\\]|\\.)*\\"|[A-Za-z0-9_$-]+)[ \t\r\n]*\??[ \t\r\n]*:)/u.test(spanSource.slice(i));
                    if (!prematureObjectClose) {
                        if (braceDepth > 0) {
                            braceDepth -= 1;
                            const afterBrace = spanSource.slice(i + 1);
                            const omittedCallCloseOnLine = /^[ \t]*;?[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(afterBrace)
                                && (
                                    onInlineHeredocCloserLine
                                    || pendingTrailingHeredocs.length > 0
                                    || !/^[ \t]*;?[ \t\r]*(?:\/\/[^\n]*)?\n(?:[ \t\r\n]|\/\/[^\n]*\n)*[),]/u.test(afterBrace)
                                );
                            if (
                                (onInlineHeredocCloserLine || tier === "model")
                                && braceDepth === 0
                                && openedCall
                                && parenDepth === 1
                                && bracketDepth === 0
                                && omittedCallCloseOnLine
                            ) {
                                parenDepth = 0;
                            }
                        } else if (openedCall && parenDepth === 1 && bracketDepth === 0 && /^;?[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(spanSource.slice(i + 1))) {
                            parenDepth = 0;
                        }
                    }
                    prevSigChar = ch;
                    i += 1;
                    if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
                        if (openedCall) {
                            while (i < spanSource.length && (spanSource[i] === " " || spanSource[i] === "\t" || spanSource[i] === "\r" || spanSource[i] === "}" || spanSource[i] === ")")) i += 1;
                            if (spanSource[i] === ";" || (spanSource[i] === "." && /^[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(spanSource.slice(i + 1)))) {
                                i += 1;
                                while (i < spanSource.length && (spanSource[i] === " " || spanSource[i] === "\t" || spanSource[i] === "\r")) i += 1;
                            }
                            if (spanSource[i] === "/" && spanSource[i + 1] === "/") {
                                const { aside, endOffset } = readTrailingAside(spanSource, i + 2);
                                trailingAside = aside;
                                i = endOffset;
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
                    while (i < spanSource.length && (spanSource[i] === " " || spanSource[i] === "\t" || spanSource[i] === "\r")) i += 1;
                    if (spanSource[i] === "/" && spanSource[i + 1] === "/") {
                        const { aside, endOffset } = readTrailingAside(spanSource, i + 2);
                        trailingAside = aside;
                        i = endOffset;
                    }
                    break;
                }
                if (ch === "\n") {
                    onInlineHeredocCloserLine = false;
                    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && (openedCall || prevSigChar !== ".")) {
                        break;
                    }
                    if (
                        tier === "model"
                        && openedCall
                        && inString === null
                        && inEscapedString === null
                        && !inBlockComment
                        && pendingTrailingHeredocs.length === 0
                        && parenDepth === 1
                        && braceDepth === 1
                        && bracketDepth === 0
                        && (prevSigChar === '"' || prevSigChar === "'" || prevSigChar === "`")
                        && hasSiblingCallAfterEol(spanSource.slice(i), executorSpellings)
                    ) {
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
                && inEscapedString === null
                && !inBlockComment
                && parenDepth === 0
                && braceDepth === 0
                && bracketDepth === 0
            ) {
                while (pendingTrailingHeredocs.length > 0) {
                    const nextTag = pendingTrailingHeredocs.shift()!;
                    const nl = spanSource.indexOf("\n", i);
                    if (nl === -1) {
                        unclosedHeredoc = true;
                        i = spanSource.length;
                        break;
                    }
                    const closer = findHeredocCloser(spanSource, nl + 1, nextTag, "trailing", {
                        allowMalformedRecovery: false,
                    });
                    if (closer === null) {
                        unclosedHeredoc = true;
                        i = spanSource.length;
                        break;
                    }
                    if (trailingAside === null && closer.trailingComment !== null) {
                        trailingAside = closer.trailingComment;
                    }
                    i = closer.lineEndOffset;
                }
            }

            const chunkText = spanSource.slice(startOffset, codeEndOffset ?? i);
            const unclosed = unclosedHeredoc
                || pendingTrailingHeredocs.length > 0
                || inString !== null
                || inEscapedString !== null
                || inBlockComment
                || parenDepth > 0
                || braceDepth > 0
                || bracketDepth > 0
                || (!openedCall && /^(?:await\s+[A-Za-z_$][A-Za-z0-9_$.]*|plurnk(?:\.[A-Za-z0-9_$]*)?)$/u.test(chunkText.trim()));

            if (unclosed && i >= spanSource.length && spanEnd === rawInput.length) {
                flushText();
                return {
                    chunks,
                    unparsedTail: {
                        from: startPos,
                        reason: "Unterminated Code Mode statement at end of input.",
                    },
                };
            }

            const rejectAsText = (!CONTAINS_CALL.test(chunkText) && !/^(?:await\s+)?plurnk\b/u.test(chunkText.trim()))
                || (tier === "model" && !isModelCodeChunk(chunkText, startPos, executorSpellings));
            if (rejectAsText) {
                const endOffset = Math.max(startOffset, (codeEndOffset ?? i) - 1);
                const endLineIdx = index.lineIndexAt(endOffset);
                for (let l = lineIdx; l <= endLineIdx; l += 1) {
                    const lbL = index.lineBounds(l);
                    const lStart = l === lineIdx ? cursor : lbL.start;
                    const lEnd = Math.min(lbL.end, spanEnd);
                    const rawText = rawInput.slice(lStart, lEnd);
                    pendingTextLines.push({
                        text: l === lineIdx && isContinuation ? rawText.trimStart() : rawText,
                        firstNonWsOffset: firstNonWsInRange(lStart, lEnd),
                    });
                }
                const lastLb = index.lineBounds(endLineIdx);
                cursor = Math.min(lastLb.nextLineStart, spanEnd);
                continue;
            }

            flushText();
            chunks.push({
                kind: "code",
                text: chunkText,
                position: startPos,
                defaultAside: trailingAside !== null && trailingAside.length > 0 ? trailingAside : null,
            });

            advanceAfterItem(startOffset, i);
        }

        flushText();
        return { chunks };
    };

    return scanSpan(0, rawInput.length);
};
