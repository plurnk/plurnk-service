const QUOTED_HEREDOC_RE = /^<<<?-?(['"]?)([A-Za-z][A-Za-z0-9_-]{0,16})\1[ \t]*\r?\n([\s\S]*?)\r?\n\2[ \t]*\r?\n?$/u;

const HEREDOC_OPEN_RE = /^<<<?-?(?:'([A-Za-z][A-Za-z0-9_-]{0,16})'|"([A-Za-z][A-Za-z0-9_-]{0,16})"|([A-Za-z][A-Za-z0-9_-]{0,16}))/u;

export const HEREDOC_OBJECT_KEYS = new WeakMap<Record<string, unknown>, ReadonlySet<string>>();

export const hasHeredocKey = (obj: Record<string, unknown> | null | undefined, ...keys: string[]): boolean => {
    if (obj === null || obj === undefined) return false;
    const set = HEREDOC_OBJECT_KEYS.get(obj);
    return set !== undefined && keys.some((k) => set.has(k));
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
    return m !== null ? m[3].replaceAll("\r\n", "\n") : null;
};

export const toStringValue = (value: unknown): string => {
    if (typeof value === "string") return unwrapQuotedHeredoc(value) ?? value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (value === null || value === undefined) return "";
    return JSON.stringify(value);
};

export interface HeredocOpenerMatch {
    readonly tag: string;
    readonly afterOpener: number;
    readonly isInline: boolean;
    readonly bodyStart: number;
}

export const matchHeredocOpener = (text: string, offset: number): HeredocOpenerMatch | null => {
    if (text[offset] !== "<" || text[offset + 1] !== "<") {
        return null;
    }
    if (text[offset + 2] !== "<") {
        let p = offset - 1;
        while (p >= 0 && (text[p] === " " || text[p] === "\t" || text[p] === "\r" || text[p] === "\n")) p -= 1;
        if (p >= 0 && !":([,+=".includes(text[p])) {
            return null;
        }
    }
    const m = HEREDOC_OPEN_RE.exec(text.slice(offset));
    if (m === null) return null;
    const tag = m[1] ?? m[2] ?? m[3] ?? "";
    const afterOpener = offset + m[0].length;
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
        };
    }
    return {
        tag,
        afterOpener,
        isInline: false,
        bodyStart: -1,
    };
};

export interface HeredocCloserMatch {
    readonly body: string;
    readonly lineStart: number;
    readonly afterTagOffset: number;
    readonly lineEndOffset: number;
    readonly nextLineStart: number;
    readonly trailingComment: string | null;
}

export const findHeredocCloser = (
    text: string,
    bodyStart: number,
    tag: string,
    mode: "inline" | "trailing",
): HeredocCloserMatch | null => {
    let lineStart = bodyStart;
    while (lineStart <= text.length) {
        const nextNl = text.indexOf("\n", lineStart);
        const lineEnd = nextNl === -1
            ? text.length
            : (nextNl > lineStart && text[nextNl - 1] === "\r" ? nextNl - 1 : nextNl);
        const line = text.slice(lineStart, lineEnd);
        let wsLen = 0;
        while (wsLen < line.length && (line[wsLen] === " " || line[wsLen] === "\t")) wsLen += 1;
        if (line.startsWith(tag, wsLen)) {
            const afterTagRaw = line.slice(wsLen + tag.length);
            const chevronMatch = mode === "inline" ? /^>+/u.exec(afterTagRaw) : null;
            const chevronLen = chevronMatch !== null ? chevronMatch[0].length : 0;
            const afterTagInLine = afterTagRaw.slice(chevronLen);
            const validAfter = mode === "inline"
                ? /^[ \t]*(?:[,}\]);+]|\/\/|\/\*|$)/u.test(afterTagInLine)
                : /^[ \t]*;?[ \t]*(?:\/\/.*)?$/u.test(afterTagInLine);
            if (validAfter) {
                let body: string;
                if (lineStart === bodyStart) {
                    body = "";
                } else {
                    const bodyEnd = text[lineStart - 1] === "\n" && lineStart >= 2 && text[lineStart - 2] === "\r"
                        ? lineStart - 2
                        : lineStart - 1;
                    body = text.slice(bodyStart, bodyEnd).replaceAll("\r\n", "\n");
                }
                const commentMatch = /^[ \t]*;?[ \t]*\/\/(.*)$/u.exec(afterTagInLine);
                const trailingComment = commentMatch !== null && commentMatch[1].trim().length > 0
                    ? commentMatch[1].trim()
                    : null;
                return {
                    body,
                    lineStart,
                    afterTagOffset: lineStart + wsLen + tag.length + chevronLen,
                    lineEndOffset: nextNl === -1 ? text.length : nextNl,
                    nextLineStart: nextNl === -1 ? text.length : nextNl + 1,
                    trailingComment,
                };
            }
        }
        if (nextNl === -1) break;
        lineStart = nextNl + 1;
    }
    return null;
};

export const maskHeredocBodies = (input: string): { readonly masked: string; readonly bodies: readonly string[] } => {
    if (!input.includes("<<")) return { masked: input, bodies: [] };
    const bodies: string[] = [];
    let out = "";
    let lastIdx = 0;
    let cursor = 0;
    while (cursor < input.length) {
        const nextIdx = input.indexOf("<<", cursor);
        if (nextIdx === -1) break;
        const opener = matchHeredocOpener(input, nextIdx);
        if (opener === null) {
            cursor = nextIdx + 2;
            continue;
        }
        if (opener.isInline) {
            const closer = findHeredocCloser(input, opener.bodyStart, opener.tag, "inline");
            if (closer !== null) {
                const rawSlice = input.slice(opener.bodyStart, closer.lineStart);
                const nlCount = (rawSlice.match(/\n/gu) ?? []).length;
                const id = bodies.length;
                bodies.push(rawSlice);
                out += input.slice(lastIdx, opener.bodyStart) + `\0HEREDOC_${id}\0${"\n".repeat(nlCount)}`;
                lastIdx = closer.lineStart;
                cursor = closer.afterTagOffset;
                continue;
            }
        } else {
            const nl = input.indexOf("\n", opener.afterOpener);
            if (nl !== -1) {
                const bodyStart = nl + 1;
                const closer = findHeredocCloser(input, bodyStart, opener.tag, "trailing");
                if (closer !== null) {
                    const rawSlice = input.slice(bodyStart, closer.lineStart);
                    const nlCount = (rawSlice.match(/\n/gu) ?? []).length;
                    const id = bodies.length;
                    bodies.push(rawSlice);
                    out += input.slice(lastIdx, bodyStart) + `\0HEREDOC_${id}\0${"\n".repeat(nlCount)}`;
                    lastIdx = closer.lineStart;
                    cursor = closer.lineEndOffset;
                    continue;
                }
            }
        }
        cursor = opener.afterOpener;
    }
    if (bodies.length === 0) return { masked: input, bodies: [] };
    out += input.slice(lastIdx);
    return { masked: out, bodies };
};

export const unmaskHeredocBodies = (masked: string, bodies: readonly string[]): string =>
    masked.replace(/\0HEREDOC_(\d+)\0\n*/gu, (_m, idxStr: string) => bodies[Number(idxStr)] ?? "");
