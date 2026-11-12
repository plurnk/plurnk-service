const QUOTED_HEREDOC_RE = /^<<<?-?(['"]?)([A-Za-z][A-Za-z0-9_-]{0,16})\1[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?\2[ \t]*\r?\n?$/u;

const HEREDOC_OPEN_RE = /^<<<?-?(?:'([A-Za-z][A-Za-z0-9_-]{0,16})'|"([A-Za-z][A-Za-z0-9_-]{0,16})"|([A-Za-z][A-Za-z0-9_-]{0,16}))/u;

export const HEREDOC_OBJECT_KEYS = new WeakMap<Record<string, unknown>, ReadonlySet<string>>();
const HEREDOC_ARRAY_INDICES = new WeakMap<readonly unknown[], ReadonlySet<number>>();

export const markHeredocKeys = (obj: Record<string, unknown>, keys: Iterable<string>): void => {
    const existing = HEREDOC_OBJECT_KEYS.get(obj);
    const merged = new Set<string>(existing);
    for (const k of keys) merged.add(k);
    if (merged.size > 0) {
        HEREDOC_OBJECT_KEYS.set(obj, merged);
    }
};

export const hasHeredocKey = (obj: Record<string, unknown> | null | undefined, ...keys: string[]): boolean => {
    if (obj === null || obj === undefined) return false;
    const set = HEREDOC_OBJECT_KEYS.get(obj);
    return set !== undefined && keys.some((k) => set.has(k));
};

export const markHeredocIndices = (arr: readonly unknown[], indices: Iterable<number>): void => {
    const existing = HEREDOC_ARRAY_INDICES.get(arr);
    const merged = new Set<number>(existing);
    for (const idx of indices) merged.add(idx);
    if (merged.size > 0) {
        HEREDOC_ARRAY_INDICES.set(arr, merged);
    }
};

export const hasHeredocIndex = (arr: readonly unknown[] | null | undefined, index: number): boolean => {
    if (arr === null || arr === undefined) return false;
    return HEREDOC_ARRAY_INDICES.get(arr)?.has(index) ?? false;
};

export const pickHeredocTag = (value: string): string => {
    if (!value.includes("EOF")) return "EOF";
    let n = 1;
    while (value.includes(`EOF${n}`)) {
        n += 1;
    }
    return `EOF${n}`;
};

export const unwrapQuotedHeredoc = (raw: string): string | null => {
    const m = QUOTED_HEREDOC_RE.exec(raw);
    return m !== null ? (m[3] ?? "").replaceAll("\r\n", "\n") : null;
};

export const toStringValue = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (value === null || value === undefined) return "";
    return JSON.stringify(value);
};

export type HeredocCloserMode = "inline" | "trailing" | "xml-attr";

export interface MatchHeredocOptions {
    readonly allowQuotedWrapper?: boolean;
    readonly allowXmlAttr?: boolean;
    readonly allowEmptyInline?: boolean;
}

export interface HeredocOpenerMatch {
    readonly tag: string;
    readonly afterOpener: number;
    readonly isInline: boolean;
    readonly isEmptyInline?: boolean;
    readonly bodyStart: number;
    readonly outerQuote?: '"' | "'" | null;
}

export interface HeredocCloserOptions {
    readonly outerQuote?: '"' | "'" | null;
    readonly allowMalformedRecovery?: boolean;
}

export interface HeredocCloserMatch {
    readonly body: string;
    readonly lineStart: number;
    readonly afterTagOffset: number;
    readonly lineEndOffset: number;
    readonly nextLineStart: number;
    readonly trailingComment: string | null;
}

const cleanHeredocBody = (rawBody: string): string => {
    const normalized = rawBody.replaceAll("\r\n", "\n");
    const trailingPlurnk = /^([\s\S]*?\S[^\n]*?)(?:\n[ \t]*)?<\/plurnk(?:[._:-][A-Za-z_$][A-Za-z0-9_$-]*)?>[ \t]*$/iu.exec(normalized);
    if (trailingPlurnk !== null && !/<plurnk(?:[\s/>._:-]|$)/iu.test(trailingPlurnk[1])) {
        return trailingPlurnk[1];
    }
    return normalized;
};

// Counts 2-chevron shell heredoc openers (`<<TAG`, `<<'TAG'`, `<<"TAG"`, `<<-TAG`, `<<\TAG`) targeting `targetTag` on a single script line.
const countShellOpenersOnLine = (line: string, targetTag: string): number => {
    if (!line.includes("<<")) return 0;
    let count = 0;
    let inQuote: '"' | "'" | null = null;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inQuote !== null) {
            if (ch === "\\" && inQuote === '"') {
                i += 1;
                continue;
            }
            if (ch === inQuote) inQuote = null;
            continue;
        }
        if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
            break;
        }
        if (ch === '"' || ch === "'") {
            inQuote = ch;
            continue;
        }
        if (
            ch === "<"
            && line[i + 1] === "<"
            && line[i + 2] !== "<"
            && (i === 0 || line[i - 1] !== "<")
        ) {
            const m = /^<<-?[ \t]*(?:'([A-Za-z][A-Za-z0-9_-]{0,16})'|"([A-Za-z][A-Za-z0-9_-]{0,16})"|\\?([A-Za-z][A-Za-z0-9_-]{0,16}))(?=[ \t;|&><)#\r]|$)/u.exec(line.slice(i));
            if (m !== null) {
                const openedTag = m[1] ?? m[2] ?? m[3] ?? "";
                if (openedTag === targetTag) count += 1;
                i += m[0].length - 1;
            }
        }
    }
    return count;
};

interface LineCloserCheck {
    readonly wsLen: number;
    readonly matchedTagLen: number;
    readonly suffixLen: number;
    readonly afterTagInLine: string;
    readonly isBareLine: boolean;
}

const checkLineCloser = (
    line: string,
    tag: string,
    mode: HeredocCloserMode,
    outerQuote: '"' | "'" | null,
    allowDigitDrift: boolean,
): LineCloserCheck | null => {
    let wsLen = 0;
    while (wsLen < line.length && (line[wsLen] === " " || line[wsLen] === "\t")) wsLen += 1;
    if (!line.startsWith(tag, wsLen)) return null;

    let matchedTagLen = tag.length;
    if (allowDigitDrift && !/\d$/u.test(tag)) {
        const digitMatch = /^\d+/u.exec(line.slice(wsLen + tag.length));
        if (digitMatch !== null) {
            matchedTagLen += digitMatch[0].length;
        }
    }

    const afterTagRaw = line.slice(wsLen + matchedTagLen);

    if (mode === "trailing") {
        if (!/^[ \t]*;?[ \t]*(?:\/\/.*)?$/u.test(afterTagRaw)) return null;
        return {
            wsLen,
            matchedTagLen,
            suffixLen: 0,
            afterTagInLine: afterTagRaw,
            isBareLine: afterTagRaw.trim() === "",
        };
    }

    if (mode === "xml-attr") {
        let quoteLen = 0;
        if (outerQuote !== null) {
            if (afterTagRaw.startsWith(outerQuote)) {
                quoteLen = 1;
                while (afterTagRaw[quoteLen] === outerQuote) quoteLen += 1;
            } else if (!/^[ \t]*\/?>/u.test(afterTagRaw)) {
                return null;
            }
        }
        const afterQuote = afterTagRaw.slice(quoteLen);
        const prematureAngleNextAttr = /^>[ \t]+(?=[A-Za-z_][A-Za-z0-9_.:-]*\s*=)/u.test(afterQuote);
        const cleanAfter = prematureAngleNextAttr
            || /^(?:[ \t]+(?=[A-Za-z_][A-Za-z0-9_.:-]*\s*=)|[ \t]*(?=\/?>)|[ \t]*$)/u.test(afterQuote);
        if (!cleanAfter) return null;
        return {
            wsLen,
            matchedTagLen,
            suffixLen: quoteLen + (prematureAngleNextAttr ? 1 : 0),
            afterTagInLine: afterQuote,
            isBareLine: quoteLen === 0 && afterQuote.trim() === "",
        };
    }

    // `mode === "inline"`
    let quotePrefixLen = 0;
    if (outerQuote !== null) {
        if (afterTagRaw.startsWith(outerQuote)) {
            quotePrefixLen = 1;
            while (afterTagRaw[quotePrefixLen] === outerQuote) quotePrefixLen += 1;
        } else if (!/^[ \t]*(?:[,}\]);]|$)/u.test(afterTagRaw)) {
            return null;
        }
    }
    const restAfterOuter = afterTagRaw.slice(quotePrefixLen);
    const suffixMatch = quotePrefixLen === 0
        ? /^(?:>+['"]*|['"]+)(?=[ \t]*(?:[,}\]);+]|\/\/|\/\*|<\/|$))/u.exec(restAfterOuter)
        : null;
    const suffixLen = quotePrefixLen + (suffixMatch !== null ? suffixMatch[0].length : 0);
    const afterTagInLine = afterTagRaw.slice(suffixLen);
    const validAfter = allowDigitDrift
        ? /^[ \t]*[,}\]);+]/u.test(afterTagInLine)
        : /^[ \t]*(?:[,}\]);+]|\/\/|\/\*|<\/[A-Za-z0-9_|｜.:\s-]+>|$)/iu.test(afterTagInLine);
    if (!validAfter) return null;
    return {
        wsLen,
        matchedTagLen,
        suffixLen,
        afterTagInLine,
        isBareLine: suffixLen === 0 && afterTagInLine.trim() === "",
    };
};

// Bounded lookahead verifying whether `needed` additional closers exist in the current statement before any new `<<<` Plurnk heredoc opener.
const hasRemainingClosersAhead = (
    text: string,
    fromOffset: number,
    tag: string,
    mode: HeredocCloserMode,
    outerQuote: '"' | "'" | null,
    initialNeeded: number,
): boolean => {
    let needed = initialNeeded;
    let cursor = fromOffset;
    while (cursor <= text.length) {
        const nextNl = text.indexOf("\n", cursor);
        const lineEnd = nextNl === -1
            ? text.length
            : (nextNl > cursor && text[nextNl - 1] === "\r" ? nextNl - 1 : nextNl);
        const line = text.slice(cursor, lineEnd);

        const closer = checkLineCloser(line, tag, mode, outerQuote, false);
        if (closer !== null) {
            if (!closer.isBareLine) return true;
            needed -= 1;
            if (needed <= 0) return true;
        } else {
            if (/<<<-?['"]?[A-Za-z]/u.test(line)) {
                return false;
            }
            needed += countShellOpenersOnLine(line, tag);
        }

        if (nextNl === -1) break;
        cursor = nextNl + 1;
    }
    return false;
};

const extractBodyBeforeLine = (text: string, bodyStart: number, lineStart: number): string => {
    if (lineStart <= bodyStart) return "";
    const bodyEnd = text[lineStart - 1] === "\n" && lineStart >= 2 && text[lineStart - 2] === "\r"
        ? lineStart - 2
        : lineStart - 1;
    return cleanHeredocBody(text.slice(bodyStart, bodyEnd));
};

const recoverMalformedCloser = (
    text: string,
    bodyStart: number,
    regionEnd: number,
    tag: string,
): HeredocCloserMatch | null => {
    // Recovery 1: Digit-drifted closer line (`<<<EOF\n...\nEOF2 })`).
    if (!/\d$/u.test(tag)) {
        let rLineStart = bodyStart;
        while (rLineStart < regionEnd) {
            const nextNl = text.indexOf("\n", rLineStart);
            const rawLineEnd = nextNl === -1 ? regionEnd : Math.min(nextNl, regionEnd);
            const lineEnd = rawLineEnd > rLineStart && text[rawLineEnd - 1] === "\r" ? rawLineEnd - 1 : rawLineEnd;
            const line = text.slice(rLineStart, lineEnd);
            const drifted = checkLineCloser(line, tag, "inline", null, true);
            if (drifted !== null && drifted.matchedTagLen > tag.length) {
                return {
                    body: extractBodyBeforeLine(text, bodyStart, rLineStart),
                    lineStart: rLineStart,
                    afterTagOffset: rLineStart + drifted.wsLen + drifted.matchedTagLen + drifted.suffixLen,
                    lineEndOffset: nextNl === -1 ? text.length : nextNl,
                    nextLineStart: nextNl === -1 ? text.length : nextNl + 1,
                    trailingComment: null,
                };
            }
            if (nextNl === -1 || nextNl >= regionEnd) break;
            rLineStart = nextNl + 1;
        }
    }

    // Recovery 2: Inline glued closer on the final body line (`...text</tool_call>EOF })` or `...text. EOF})`).
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const gluedRe = new RegExp(
        `^([\\s\\S]+?)(?:[ \\t]*<\\/?(?:tool_call|TOOLCALL|function_call)\\b[^>]*>[ \\t]*|[ \\t]+)${escapedTag}(>+['"]*|['"]*)?(?=[ \\t]*[,}\\]);+])`,
        "iu",
    );
    const region = text.slice(bodyStart, regionEnd);
    const glued = gluedRe.exec(region);
    if (glued !== null) {
        const suffixLen = glued[2]?.length ?? 0;
        const afterTagOffset = bodyStart + glued[0].length;
        const nextNl = text.indexOf("\n", afterTagOffset);
        const closerStart = afterTagOffset - suffixLen - tag.length;
        return {
            body: cleanHeredocBody(glued[1]),
            lineStart: closerStart,
            afterTagOffset,
            lineEndOffset: nextNl === -1 ? text.length : nextNl,
            nextLineStart: nextNl === -1 ? text.length : nextNl + 1,
            trailingComment: null,
        };
    }

    return null;
};

export const findHeredocCloser = (
    text: string,
    bodyStart: number,
    tag: string,
    mode: HeredocCloserMode,
    options: HeredocCloserOptions = {},
): HeredocCloserMatch | null => {
    const outerQuote = options.outerQuote ?? null;
    const allowRecovery = options.allowMalformedRecovery ?? (mode === "inline" && outerQuote === null);
    const nextTripleOpener = allowRecovery ? text.indexOf("<<<", bodyStart) : -1;

    let lineStart = bodyStart;
    let nestedShellDepth = 0;

    while (lineStart <= text.length) {
        const nextNl = text.indexOf("\n", lineStart);
        const lineEnd = nextNl === -1
            ? text.length
            : (nextNl > lineStart && text[nextNl - 1] === "\r" ? nextNl - 1 : nextNl);
        const line = text.slice(lineStart, lineEnd);
        const nextLineStart = nextNl === -1 ? text.length : nextNl + 1;

        const check = checkLineCloser(line, tag, mode, outerQuote, false);
        if (check !== null) {
            if (allowRecovery && nextTripleOpener !== -1 && nextTripleOpener < lineStart) {
                const earlierMalformed = recoverMalformedCloser(text, bodyStart, nextTripleOpener, tag);
                if (earlierMalformed !== null) {
                    return earlierMalformed;
                }
            }
            if (
                check.isBareLine
                && nestedShellDepth > 0
                && nextNl !== -1
                && hasRemainingClosersAhead(text, nextLineStart, tag, mode, outerQuote, nestedShellDepth)
            ) {
                nestedShellDepth -= 1;
                lineStart = nextLineStart;
                continue;
            }
            const commentMatch = /^[ \t]*;?[ \t]*\/\/(.*)$/u.exec(check.afterTagInLine);
            const trailingComment = commentMatch !== null && commentMatch[1].trim().length > 0
                ? commentMatch[1].trim()
                : null;
            return {
                body: extractBodyBeforeLine(text, bodyStart, lineStart),
                lineStart,
                afterTagOffset: lineStart + check.wsLen + check.matchedTagLen + check.suffixLen,
                lineEndOffset: nextNl === -1 ? text.length : nextNl,
                nextLineStart,
                trailingComment,
            };
        }

        nestedShellDepth += countShellOpenersOnLine(line, tag);
        if (nextNl === -1) break;
        lineStart = nextLineStart;
    }

    if (!allowRecovery) return null;

    const regionEnd = nextTripleOpener === -1 ? text.length : nextTripleOpener;
    return recoverMalformedCloser(text, bodyStart, regionEnd, tag);
};

export const matchHeredocOpener = (
    text: string,
    offset: number,
    options: MatchHeredocOptions = {},
): HeredocOpenerMatch | null => {
    const ch = text[offset];
    if (options.allowQuotedWrapper === true && (ch === '"' || ch === "'") && text[offset + 1] === "<" && text[offset + 2] === "<") {
        const outerQuote = ch;
        const m = HEREDOC_OPEN_RE.exec(text.slice(offset + 1));
        if (m === null) return null;
        const tag = m[1] ?? m[2] ?? m[3] ?? "";
        const afterOpener = offset + 1 + m[0].length;
        const inlineNl = /^[ \t]*\r?\n/u.exec(text.slice(afterOpener));
        if (inlineNl === null) return null;
        const bodyStart = afterOpener + inlineNl[0].length;
        const mode: HeredocCloserMode = options.allowXmlAttr === true ? "xml-attr" : "inline";
        if (findHeredocCloser(text, bodyStart, tag, mode, { outerQuote, allowMalformedRecovery: false }) === null) {
            return null;
        }
        return {
            tag,
            afterOpener,
            isInline: true,
            bodyStart,
            outerQuote,
        };
    }

    if (ch !== "<" || text[offset + 1] !== "<") {
        return null;
    }
    const isTriple = text[offset + 2] === "<";
    if (!isTriple && options.allowXmlAttr !== true) {
        let p = offset - 1;
        while (p >= 0 && (text[p] === " " || text[p] === "\t" || text[p] === "\r" || text[p] === "\n")) p -= 1;
        if (p >= 0 && !":([,+={".includes(text[p])) {
            return null;
        }
    }
    const m = HEREDOC_OPEN_RE.exec(text.slice(offset));
    if (m === null) return null;
    const tag = m[1] ?? m[2] ?? m[3] ?? "";
    const afterOpener = offset + m[0].length;

    if (options.allowXmlAttr === true) {
        const xmlNl = /^[ \t]*\r?\n/u.exec(text.slice(afterOpener));
        if (xmlNl === null) return null;
        return {
            tag,
            afterOpener,
            isInline: true,
            bodyStart: afterOpener + xmlNl[0].length,
            outerQuote: null,
        };
    }

    if (!/^[ \t]*(?:[,})\];]|\/\/|\r?\n|$)/u.test(text.slice(afterOpener))) {
        return null;
    }
    const inlineNl = /^[ \t]*(?:\/\/[^\r\n]*)?\r?\n/u.exec(text.slice(afterOpener));
    if (inlineNl !== null) {
        return {
            tag,
            afterOpener,
            isInline: true,
            bodyStart: afterOpener + inlineNl[0].length,
            outerQuote: null,
        };
    }

    if (options.allowEmptyInline === true && isTriple && /^[ \t]*[}\]]/u.test(text.slice(afterOpener))) {
        const eol = text.indexOf("\n", afterOpener);
        const hasTrailingCloser = eol !== -1 && (() => {
            const nextOpener = text.indexOf("<<<", eol + 1);
            const region = nextOpener === -1 ? text : text.slice(0, nextOpener);
            return findHeredocCloser(region, eol + 1, tag, "trailing", { allowMalformedRecovery: false }) !== null;
        })();
        if (!hasTrailingCloser) {
            return {
                tag,
                afterOpener,
                isInline: true,
                isEmptyInline: true,
                bodyStart: afterOpener,
                outerQuote: null,
            };
        }
    }

    return {
        tag,
        afterOpener,
        isInline: false,
        bodyStart: -1,
        outerQuote: null,
    };
};
