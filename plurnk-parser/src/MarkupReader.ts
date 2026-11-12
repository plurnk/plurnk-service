import {
    isRecord,
    type Position,
    type RuntimeTag,
} from "@plurnk/plurnk-contracts";
import { parsePythonicCalls, parseValuePrefix } from "./CallExpressionParser.ts";
import {
    HEREDOC_OBJECT_KEYS,
    findHeredocCloser,
    markHeredocKeys,
    matchHeredocOpener,
} from "./HeredocSyntax.ts";
import type { ParsedCall } from "./OptionCoercion.ts";
import { readTrailingAside, type SourceIndex } from "./SourceIndex.ts";
import {
    coerceParamValue,
    decodeJsonOrValueCalls,
    decodePythonicCalls,
    extractProxyCalls,
    normalizeDecodedArgs,
    parseWrapperTag,
    resolveCallChain,
    unescapeAttrValue,
} from "./TargetResolver.ts";

const DIRECT_XML_PARAM_KEYS: ReadonlySet<string> = new Set([
    "path", "paths", "target", "targets", "uri", "file_path", "filepath", "file",
    "range", "lines", "scope", "limit", "pattern", "matcher", "query",
    "content", "body", "text", "message", "note", "distillation", "reason", "summary",
    "oldtext", "old_string", "old_text", "newtext", "new_string", "new_text", "edits",
    "items", "todos", "from", "source", "src", "to", "destination", "dest",
    "torange", "destinationrange", "destrange", "topattern", "destinationpattern",
    "fromheaders", "sourceheaders", "toheaders", "destinationheaders",
    "prompt", "seconds", "duration", "headers", "attachments", "remote",
    "command", "code", "script", "args", "cwd", "action", "aside",
    "owner", "repo", "number", "index",
]);

const skipStructuredPayloadPrefix = (text: string, fromOffset: number): number => {
    let p = fromOffset;
    while (p < text.length && /\s/u.test(text[p])) p += 1;
    if (p >= text.length) return fromOffset;
    if (text[p] === "{" || text[p] === "[") {
        let cursor = p;
        while (cursor < text.length && (text[cursor] === "{" || text[cursor] === "[")) {
            const val = parseValuePrefix(text, cursor);
            if (val === null || val.endOffset <= cursor) break;
            cursor = val.endOffset;
            while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
        }
        if (cursor > p) return cursor;
        if (text[p] === "[") {
            const py = parsePythonicCalls(text.slice(p), { line: 1, column: 0 }, true);
            if (py !== null && py.endOffset > 0) return p + py.endOffset;
        }
    }
    return fromOffset;
};

export const findCloseSkippingHeredocs = (
    text: string,
    bodyStart: number,
    closePattern: string,
    sameOpenPattern?: string,
): { readonly innerEnd: number; readonly closeEnd: number } | null => {
    const tokenRe = sameOpenPattern !== undefined
        ? new RegExp(`(${closePattern})|(${sameOpenPattern})`, "giu")
        : new RegExp(`(${closePattern})`, "giu");
    let scanFrom = skipStructuredPayloadPrefix(text, bodyStart);
    tokenRe.lastIndex = scanFrom;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(text)) !== null) {
        const tripleIdx = text.indexOf("<<<", scanFrom);
        if (tripleIdx !== -1 && tripleIdx < m.index) {
            const opener = matchHeredocOpener(text, tripleIdx, { allowEmptyInline: true });
            if (opener !== null && opener.isInline) {
                if (opener.isEmptyInline === true) {
                    scanFrom = opener.afterOpener;
                    tokenRe.lastIndex = scanFrom;
                    continue;
                }
                const closer = findHeredocCloser(text, opener.bodyStart, opener.tag, "inline");
                if (closer !== null && closer.afterTagOffset > tripleIdx) {
                    scanFrom = closer.afterTagOffset;
                    tokenRe.lastIndex = scanFrom;
                    continue;
                }
            }
            scanFrom = tripleIdx + 3;
            tokenRe.lastIndex = scanFrom;
            continue;
        }
        if (m[2] !== undefined) return null;
        if (m[1] !== undefined) {
            return { innerEnd: m.index, closeEnd: m.index + m[1].length };
        }
    }
    return null;
};

interface ParsedXmlBodyResult {
    readonly value: unknown;
    readonly isTopHeredoc: boolean;
}

export const parseXmlToolCallBodyWithMeta = (body: string): ParsedXmlBodyResult => {
    const unwrappedBody = body
        .trim()
        .replace(/^<(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameters|params|arguments|args|input)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameters|params|arguments|args|input)>$/iu, "$1");

    // 1. Z.AI GLM `<arg_key>k</arg_key><arg_value>v</arg_value>` / `<param_key>` / `<parameter_key>` pairs.
    const glmKeyOpenRe = /<(?:arg|param|parameter)_key\b[^>]*>([\s\S]*?)<\/(?:arg|param|parameter)_key>\s*<(?:arg|param|parameter)_value\b[^>]*>/giu;
    const glmParams: Record<string, unknown> = {};
    const glmHeredocKeys = new Set<string>();
    let matchedGlm = false;
    let m: RegExpExecArray | null;
    while ((m = glmKeyOpenRe.exec(unwrappedBody)) !== null) {
        const valStart = m.index + m[0].length;
        const valClose = findCloseSkippingHeredocs(unwrappedBody, valStart, "<\\/(?:arg|param|parameter)_value>");
        if (valClose === null) break;
        matchedGlm = true;
        const key = m[1].trim();
        if (key.length > 0) {
            const rawVal = unwrappedBody.slice(valStart, valClose.innerEnd).replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
            const coerced = coerceParamValue(rawVal);
            glmParams[key] = coerced.value;
            if (coerced.isHeredoc) glmHeredocKeys.add(key);
        }
        glmKeyOpenRe.lastIndex = valClose.closeEnd;
    }
    if (matchedGlm) {
        markHeredocKeys(glmParams, glmHeredocKeys);
        return { value: glmParams, isTopHeredoc: false };
    }

    // 2. Anthropic / DSML `<parameter name="k">v</parameter>` and `<param=k>v</param>`.
    const paramOpenRe = /<(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|DSML[|｜]+|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameter|param|arg|argument)\b(?:\s+name=[“”"'‘’]([^“”"'‘’]+)[“”"'‘’]|=([A-Za-z0-9_.-]+))[^>]*>/giu;
    const params: Record<string, unknown> = {};
    const paramHeredocKeys = new Set<string>();
    let matchedParam = false;
    while ((m = paramOpenRe.exec(unwrappedBody)) !== null) {
        matchedParam = true;
        const key = (m[1] ?? m[2] ?? "").trim();
        const valStart = m.index + m[0].length;
        const closeOrNext = findCloseSkippingHeredocs(
            unwrappedBody,
            valStart,
            "<\\/(?:antml:|(?:[|｜]+)?DSML[|｜]+\\s*|DSML[|｜]+|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameter|param|arg|argument)>|(?=<(?:antml:|(?:[|｜]+)?DSML[|｜]+\\s*|DSML[|｜]+|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameter|param|arg|argument)\\b)",
        );
        const valEnd = closeOrNext !== null ? closeOrNext.innerEnd : unwrappedBody.length;
        if (key.length > 0) {
            const rawVal = unwrappedBody
                .slice(valStart, valEnd)
                .replace(/^\r?\n/u, "")
                .replace(/\r?\n$/u, "")
                .replace(/^(?:true|false)["']>/iu, "");
            const coerced = coerceParamValue(rawVal);
            params[key] = coerced.value;
            if (coerced.isHeredoc) paramHeredocKeys.add(key);
        }
        paramOpenRe.lastIndex = closeOrNext !== null ? Math.max(valStart, closeOrNext.closeEnd) : unwrappedBody.length;
        if (closeOrNext === null) break;
    }
    if (matchedParam) {
        markHeredocKeys(params, paramHeredocKeys);
        return { value: params, isTopHeredoc: false };
    }

    // 3. Direct XML field tags (`<path>...</path><range>...</range>`).
    const directOpenRe = /<(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?([A-Za-z_][A-Za-z0-9_-]*)\b[^>]*>/giu;
    const directParams: Record<string, unknown> = {};
    const directHeredocKeys = new Set<string>();
    let matchedDirectField = false;
    while ((m = directOpenRe.exec(unwrappedBody)) !== null) {
        const rawKey = m[1].trim();
        if (!DIRECT_XML_PARAM_KEYS.has(rawKey.toLowerCase())) continue;
        const valStart = m.index + m[0].length;
        const escapedKey = rawKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const valClose = findCloseSkippingHeredocs(
            unwrappedBody,
            valStart,
            `<\\/(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?${escapedKey}>`,
        );
        if (valClose === null) continue;
        matchedDirectField = true;
        const rawVal = unwrappedBody.slice(valStart, valClose.innerEnd).replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
        const coerced = coerceParamValue(rawVal);
        directParams[rawKey] = coerced.value;
        if (coerced.isHeredoc) directHeredocKeys.add(rawKey);
        directOpenRe.lastIndex = valClose.closeEnd;
    }
    if (matchedDirectField) {
        markHeredocKeys(directParams, directHeredocKeys);
        return { value: directParams, isTopHeredoc: false };
    }

    // 4. Top-level heredoc body (`<plurnk.edit path="a.ts"><<<EOF\n...\nEOF</plurnk.edit>`).
    const topHeredoc = coerceParamValue(unwrappedBody);
    if (topHeredoc.isHeredoc) {
        return { value: topHeredoc.value, isTopHeredoc: true };
    }

    // 5. JSON or Code Mode object/array body (including `<parameter={...}</parameter>` and trailing `</parameter>`).
    const cleaned = unwrappedBody
        .replace(/^<(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|DSML[|｜]+|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameter|param|arg|argument)\s*=\s*(?=\{)/iu, "")
        .replace(/(?:\s*<\/(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|DSML[|｜]+|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameter|param|arg|argument)\b[^<>]*>)+$/iu, "")
        .replace(/\}>\s*$/u, "}")
        .trim()
        .replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu, "$1")
        .trim();
    if (cleaned.length === 0) return { value: {}, isTopHeredoc: false };
    if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
        try {
            return { value: JSON.parse(cleaned), isTopHeredoc: false };
        } catch {
            const candidate = cleaned.replace(/([}\]])[ \t]*\)+[ \t]*;?$/u, "$1");
            const valueParsed = parseValuePrefix(candidate, 0);
            if (valueParsed !== null && candidate.slice(valueParsed.endOffset).trim() === "") {
                return { value: valueParsed.value, isTopHeredoc: false };
            }
            return { value: cleaned, isTopHeredoc: false };
        }
    }
    return { value: cleaned, isTopHeredoc: false };
};

export const parseXmlToolCallBody = (body: string): unknown => parseXmlToolCallBodyWithMeta(body).value;

export const decodeChildTagCalls = (
    inner: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    position: Position,
    defaultService?: string,
    isResultWrapper = false,
): readonly ParsedCall[] | null => {
    const glmHeadMatch = /^\s*([A-Za-z0-9_.:-]+)\s*(?=<(?:arg|param|parameter)_key\b)/iu.exec(inner);
    if (glmHeadMatch !== null) {
        const chain = resolveCallChain(glmHeadMatch[1], executorSpellings, false, defaultService);
        if (chain !== null) {
            const remainder = inner.slice(glmHeadMatch[0].length);
            return [{ chain, args: normalizeDecodedArgs(parseXmlToolCallBody(remainder)), position }];
        }
    }

    const nameMatch = /<(?:([A-Za-z_$][A-Za-z0-9_$]*)[._:-])?(?:name|tool|tool_name|function)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:name|tool|tool_name|function)>/iu.exec(inner);
    if (nameMatch === null) return null;
    if (
        isResultWrapper
        && /<output\b[^>]*>[\s\S]*?<\/output>/iu.test(inner)
        && !/<(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:arguments|args|parameters|params|input|parameter|param|arg|argument)\b/iu.test(inner)
    ) {
        return null;
    }
    const childPrefix = nameMatch[1]?.toLowerCase();
    const effectiveDefaultService = defaultService ?? (childPrefix === "antml" || childPrefix === "dsml" ? undefined : childPrefix);
    const rawName = nameMatch[2].trim();
    const chain = resolveCallChain(rawName, executorSpellings, false, effectiveDefaultService);
    if (chain === null) return null;
    const argsMatch = /<(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:arguments|args|parameters|params|input)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:arguments|args|parameters|params|input)>/iu.exec(inner);
    const remainder = argsMatch !== null
        ? argsMatch[1]
        : inner.replace(nameMatch[0], "").trim();
    const bodyMeta = remainder.length === 0 ? undefined : parseXmlToolCallBodyWithMeta(remainder);
    return [{ chain, args: normalizeDecodedArgs(bodyMeta?.value, bodyMeta?.isTopHeredoc === true), position }];
};

interface ScannedAttributes {
    readonly attrs: Record<string, unknown>;
    readonly heredocKeys: Set<string>;
    readonly tagHeadEnd: number;
    readonly selfClosing: boolean;
    readonly inlineCallCode?: {
        readonly codeText: string;
        readonly aside: string | null;
        readonly endOffset: number;
    };
}

const scanBalancedInlineInvokeCall = (
    text: string,
    callStart: number,
    rawWrapperTag: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
): { readonly codeText: string; readonly aside: string | null; readonly endOffset: number } | null => {
    const headMatch = /^(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$.:-]*)\s*\(/u.exec(text.slice(callStart));
    if (headMatch === null) return null;
    const chain = resolveCallChain(headMatch[1], executorSpellings, false, defaultService);
    if (chain === null) return null;

    let i = callStart + headMatch[0].length;
    let parenDepth = 1;
    let inQuote: '"' | "'" | "`" | null = null;
    while (i < text.length && parenDepth > 0) {
        const ch = text[i];
        if (inQuote !== null) {
            if (ch === "\\") {
                i += 2;
                continue;
            }
            if (ch === inQuote) inQuote = null;
            i += 1;
            continue;
        }
        if (ch === "<" && text[i + 1] === "<") {
            const opener = matchHeredocOpener(text, i);
            if (opener !== null && opener.isInline) {
                const closer = findHeredocCloser(text, opener.bodyStart, opener.tag, "inline");
                if (closer !== null) {
                    i = closer.afterTagOffset;
                    continue;
                }
            }
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            inQuote = ch;
            i += 1;
            continue;
        }
        if (ch === "(") parenDepth += 1;
        else if (ch === ")") parenDepth -= 1;
        i += 1;
    }
    if (parenDepth !== 0) return null;

    const rawArgs = text.slice(callStart + headMatch[0].length, i - 1).trim();
    const targetExpr = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(chain[1])
        ? `${chain[0]}.${chain[1]}`
        : `${chain[0]}[${JSON.stringify(chain[1])}]`;
    const codeText = rawArgs.length === 0 ? `${targetExpr}()` : `${targetExpr}(${rawArgs})`;

    while (i < text.length && (text[i] === ";" || text[i] === " " || text[i] === "\t" || /[“”"'‘’]/u.test(text[i]))) {
        i += 1;
    }
    let aside: string | null = null;
    if (text[i] === "/" && text[i + 1] === "/") {
        let commentEnd = i + 2;
        while (commentEnd < text.length && text[commentEnd] !== "\n" && text[commentEnd] !== "<") {
            commentEnd += 1;
        }
        const trimmedComment = text.slice(i + 2, commentEnd).replace(/[“”"'‘’\r]+$/u, "").trim();
        if (trimmedComment.length > 0) aside = trimmedComment;
        i = commentEnd;
        while (i < text.length && (text[i] === " " || text[i] === "\t" || /[“”"'‘’]/u.test(text[i]))) {
            i += 1;
        }
    }

    if (text.startsWith("/>", i)) {
        return { codeText, aside, endOffset: i + 2 };
    }

    const closeVerb = rawWrapperTag.replace(/^(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|DSML[|｜]+|[A-Za-z_$][A-Za-z0-9$]*[._:-])/iu, "").trim();
    const escapedVerb = closeVerb.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const closeRe = new RegExp(`^[\\s\\S]*?<\\/(?:antml:|(?:[|｜]+)?DSML[|｜]+\\s*|DSML[|｜]+|[A-Za-z_$][A-Za-z0-9$]*[._:-])?${escapedVerb}>`, "iu");
    const closeMatch = closeRe.exec(text.slice(i));
    if (closeMatch !== null) {
        return { codeText, aside, endOffset: i + closeMatch[0].length };
    }
    return null;
};

const scanXmlAttributes = (
    text: string,
    startPos: number,
    options?: {
        readonly isWrapper?: boolean;
        readonly rawTag?: string;
        readonly executorSpellings?: ReadonlyMap<string, RuntimeTag>;
        readonly defaultService?: string;
    },
): ScannedAttributes | null => {
    let pos = startPos;
    const attrs: Record<string, unknown> = {};
    const heredocKeys = new Set<string>();

    while (pos < text.length) {
        while (pos < text.length && (text[pos] === " " || text[pos] === "\t" || text[pos] === "\r" || text[pos] === "\n")) {
            pos += 1;
        }
        if (pos >= text.length) return null;

        if (text.startsWith("/>", pos)) {
            return { attrs, heredocKeys, tagHeadEnd: pos + 2, selfClosing: true };
        }
        if (text[pos] === ">") {
            return { attrs, heredocKeys, tagHeadEnd: pos + 1, selfClosing: false };
        }

        const keyMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*/u.exec(text.slice(pos));
        if (keyMatch === null) return null;
        const key = keyMatch[1].trim();
        const lowerKey = key.toLowerCase();
        pos += keyMatch[0].length;
        if (pos >= text.length) return null;

        // Malformed inline Code Mode call stuffed inside `name="plurnk.op(...)"`.
        if (
            options?.isWrapper === true
            && options.rawTag !== undefined
            && options.executorSpellings !== undefined
            && (lowerKey === "name" || lowerKey === "call" || lowerKey === "tool" || lowerKey === "op")
            && /[“”"'‘’]/u.test(text[pos])
            && /^(?:await\s+)?[A-Za-z_$][A-Za-z0-9_$.:-]*\s*\(/u.test(text.slice(pos + 1))
        ) {
            const inlineCallCode = scanBalancedInlineInvokeCall(
                text,
                pos + 1,
                options.rawTag,
                options.executorSpellings,
                options.defaultService,
            );
            if (inlineCallCode !== null) {
                return {
                    attrs,
                    heredocKeys,
                    tagHeadEnd: inlineCallCode.endOffset,
                    selfClosing: true,
                    inlineCallCode,
                };
            }
        }

        // 1. Unquoted heredoc attribute (`key=<<<EOF\n...\nEOF`).
        if (text[pos] === "<" && text[pos + 1] === "<") {
            const opener = matchHeredocOpener(text, pos, { allowXmlAttr: true });
            if (opener === null) return null;
            const closer = findHeredocCloser(text, opener.bodyStart, opener.tag, "xml-attr", { outerQuote: null });
            if (closer === null) return null;
            if (lowerKey !== "xmlns" && !lowerKey.startsWith("xmlns:")) {
                attrs[key] = closer.body;
                heredocKeys.add(key);
            }
            pos = closer.afterTagOffset;
            continue;
        }

        // 2. Quoted wrapper heredoc attribute (`key="<<<EOF\n...\nEOF"` or `key='<<<EOF\n...\nEOF'`).
        if ((text[pos] === '"' || text[pos] === "'") && text[pos + 1] === "<" && text[pos + 2] === "<") {
            const opener = matchHeredocOpener(text, pos, { allowQuotedWrapper: true, allowXmlAttr: true });
            if (opener !== null) {
                const closer = findHeredocCloser(text, opener.bodyStart, opener.tag, "xml-attr", {
                    outerQuote: opener.outerQuote ?? null,
                    allowMalformedRecovery: false,
                });
                if (closer !== null) {
                    if (lowerKey !== "xmlns" && !lowerKey.startsWith("xmlns:")) {
                        attrs[key] = closer.body;
                        heredocKeys.add(key);
                    }
                    pos = closer.afterTagOffset;
                    continue;
                }
            }
        }

        // 3. Quoted string attribute (`"..."`, `'...'`, `“...”`, `‘...’`) with unescaped-inner-quote lookahead.
        const q = text[pos];
        if (q === '"' || q === "'" || q === "“" || q === "‘") {
            const closeQuote = q === "“" ? "”" : q === "‘" ? "’" : q;
            const unescapeKind: '"' | "'" = (q === '"' || q === "“") ? '"' : "'";
            pos += 1;
            let raw = "";
            let closed = false;
            while (pos < text.length) {
                const ch = text[pos];
                if (ch === "\\" && (closeQuote === '"' || closeQuote === "'")) {
                    if (pos + 1 >= text.length) return null;
                    raw += text.slice(pos, pos + 2);
                    pos += 2;
                    continue;
                }
                if (ch === closeQuote) {
                    const afterQuote = text.slice(pos + 1);
                    if (/^(?:\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=|\s*\/?>)/u.test(afterQuote)) {
                        pos += 1;
                        closed = true;
                        break;
                    }
                }
                raw += ch;
                pos += 1;
            }
            if (!closed) return null;
            if (lowerKey !== "xmlns" && !lowerKey.startsWith("xmlns:")) {
                const unescaped = unescapeAttrValue(raw, unescapeKind);
                const coerced = coerceParamValue(unescaped);
                attrs[key] = coerced.value;
                if (coerced.isHeredoc) heredocKeys.add(key);
            }
            continue;
        }

        // 4. Bare unquoted attribute token (`range=1,10`).
        const bareMatch = /^([^\s"'=<>`/]+)/u.exec(text.slice(pos));
        if (bareMatch === null) return null;
        pos += bareMatch[0].length;
        if (lowerKey !== "xmlns" && !lowerKey.startsWith("xmlns:")) {
            const coerced = coerceParamValue(bareMatch[1]);
            attrs[key] = coerced.value;
            if (coerced.isHeredoc) heredocKeys.add(key);
        }
    }

    return null;
};

export type MarkupScanResult =
    | {
        readonly kind: "calls";
        readonly calls: readonly ParsedCall[];
        readonly attemptText: string;
        readonly position: Position;
        readonly defaultAside: string | null;
        readonly endOffset: number;
    }
    | {
        readonly kind: "code";
        readonly text: string;
        readonly position: Position;
        readonly defaultAside: string | null;
        readonly endOffset: number;
    }
    | {
        readonly kind: "unwrap-span";
        readonly innerStart: number;
        readonly innerEnd: number;
        readonly endOffset: number;
        readonly defaultService?: string;
        readonly isSystem?: boolean;
    }
    | {
        readonly kind: "unwrap-prefix";
        readonly innerOffset: number;
    };

// Scans angle-bracketed or stuttered Code Mode hybrid calls (`<await plurnk.edit({...})/>`, `<tool<plurnk.edit(...)`, `<<plurnk.edit(...)`, `<plurnk.read({...}/>`).
const scanAngleHybridCall = (
    source: string,
    offset: number,
    index: SourceIndex,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
): MarkupScanResult | null => {
    const prefixMatch = /^(?:<[A-Za-z0-9_:|｜-]*\s*)*<(?:([A-Za-z_$][A-Za-z0-9_$-]*):)?((?:await\s+)?([A-Za-z_$][A-Za-z0-9_$-]*\.[A-Za-z_$][A-Za-z0-9_$-]*)\s*\()/u.exec(source.slice(offset));
    if (prefixMatch === null) return null;
    const rawTarget = prefixMatch[3];
    if (resolveCallChain(rawTarget, executorSpellings, true) === null) return null;

    const callStart = offset + prefixMatch[0].length - prefixMatch[2].length;
    let i = offset + prefixMatch[0].length; // right after `(`
    let parenDepth = 1;
    let braceDepth = 0;
    let bracketDepth = 0;
    let inQuote: '"' | "'" | "`" | null = null;
    let inBlockComment = false;
    let missingCloseParenAt: number | null = null;

    while (i < source.length && parenDepth > 0) {
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
        if (inQuote !== null) {
            if (ch === "\\") {
                i += 2;
                continue;
            }
            if (ch === inQuote) inQuote = null;
            i += 1;
            continue;
        }
        if (ch === "/" && next === "/") {
            const eol = source.indexOf("\n", i + 2);
            i = eol === -1 ? source.length : eol + 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlockComment = true;
            i += 2;
            continue;
        }
        if (ch === "<" && next === "<") {
            const opener = matchHeredocOpener(source, i, { allowEmptyInline: true });
            if (opener !== null && opener.isInline) {
                if (opener.isEmptyInline === true) {
                    i = opener.afterOpener;
                    continue;
                }
                const closer = findHeredocCloser(source, opener.bodyStart, opener.tag, "inline");
                if (closer === null) return null;
                i = closer.afterTagOffset;
                continue;
            }
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            inQuote = ch;
            i += 1;
            continue;
        }
        if (ch === "{") braceDepth += 1;
        else if (ch === "}") {
            if (braceDepth > 0) braceDepth -= 1;
            if (parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
                const afterBrace = source.slice(i + 1);
                const xmlClosedInsteadOfParen = /^[ \t]*(\/?>)/u.exec(afterBrace);
                if (xmlClosedInsteadOfParen !== null && !/^[ \t]*\/?>[ \t]*\)/u.test(afterBrace)) {
                    missingCloseParenAt = i + 1;
                    i += 1 + xmlClosedInsteadOfParen[0].length;
                    parenDepth = 0;
                    break;
                }
            }
        } else if (ch === "[") bracketDepth += 1;
        else if (ch === "]") {
            if (bracketDepth > 0) bracketDepth -= 1;
        } else if (ch === "(") parenDepth += 1;
        else if (ch === ")") parenDepth -= 1;
        i += 1;
    }

    if (parenDepth !== 0) return null;
    const rawCallText = missingCloseParenAt !== null
        ? `${source.slice(callStart, missingCloseParenAt)})`
        : source.slice(callStart, i);

    while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === ";" || source[i] === "}" || source[i] === ")")) {
        i += 1;
    }
    if (source.startsWith("/>", i)) i += 2;
    else if (source[i] === ">") i += 1;
    while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "}" || source[i] === ")" || source[i] === ";")) {
        i += 1;
    }
    const closeTagRe = /^<\/(?:await|[A-Za-z_$][A-Za-z0-9_$.:-]*)>/iu;
    const preCommentClose = closeTagRe.exec(source.slice(i));
    if (preCommentClose !== null) {
        i += preCommentClose[0].length;
        while (i < source.length && (source[i] === " " || source[i] === "\t")) i += 1;
    }

    let defaultAside: string | null = null;
    if (source[i] === "/" && source[i + 1] === "/") {
        const { aside, endOffset } = readTrailingAside(source, i + 2);
        const cleanedAside = aside.replace(/<\/(?:await|[A-Za-z_$][A-Za-z0-9_$.:-]*)>[ \t]*$/iu, "").trim();
        defaultAside = cleanedAside.length > 0 ? cleanedAside : null;
        i = endOffset;
    }

    return {
        kind: "code",
        text: rawCallText,
        position: index.positionAt(callStart),
        defaultAside,
        endOffset: i,
    };
};

const findMatchingCloseTag = (
    source: string,
    afterOpenGt: number,
    rawTag: string,
    hadAwaitPrefix: boolean,
): { readonly innerEnd: number; readonly closeEnd: number } | null => {
    const normalizedTag = rawTag.replace(/\s+pending$/iu, "").trim();
    const dsmlMatch = /^(?:[|｜]+)?DSML[|｜]+\s*([A-Za-z0-9_ -]+)$/iu.exec(normalizedTag);
    const escapedTag = normalizedTag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const closePattern = dsmlMatch !== null
        ? `<\\/(?:[|｜]+)?DSML[|｜]+\\s*${dsmlMatch[1].trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}>|<\\/DSML[|｜]+${dsmlMatch[1].trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}>`
        : hadAwaitPrefix
            ? `<\\/(?:await|${escapedTag})>`
            : `<\\/${escapedTag}>`;
    const sameOpenPattern = dsmlMatch !== null
        ? `<(?:[|｜]+)?DSML[|｜]+\\s*${dsmlMatch[1].trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`
        : `<${escapedTag}(?:\\s+pending)?(?=[\\s/>])`;

    return findCloseSkippingHeredocs(source, afterOpenGt, closePattern, sameOpenPattern);
};

const buildNamedXmlCalls = (
    chain: readonly [string, string] | null,
    attrs: Record<string, unknown>,
    heredocKeys: ReadonlySet<string>,
    innerBody: string | undefined,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    position: Position,
    defaultService?: string,
    rawVerb?: string,
): readonly ParsedCall[] | null => {
    const bodyMeta = innerBody !== undefined && innerBody.trim().length > 0
        ? parseXmlToolCallBodyWithMeta(innerBody)
        : undefined;
    const parsedBody = bodyMeta?.value;

    if (
        rawVerb?.toLowerCase() === "result"
        && Object.keys(attrs).length === 0
        && !isRecord(parsedBody)
        && !Array.isArray(parsedBody)
    ) {
        return null;
    }

    if (chain === null) {
        return extractProxyCalls(parsedBody, executorSpellings, position, defaultService);
    }

    let finalArgs: unknown = Object.keys(attrs).length > 0 ? { ...attrs } : undefined;
    let finalIsTopHeredoc = false;
    if (parsedBody !== undefined) {
        if (finalArgs === undefined) {
            finalArgs = parsedBody;
            finalIsTopHeredoc = bodyMeta?.isTopHeredoc === true;
        } else if (isRecord(finalArgs) && isRecord(parsedBody)) {
            const merged: Record<string, unknown> = { ...finalArgs, ...parsedBody };
            const bodyHeredocs = HEREDOC_OBJECT_KEYS.get(parsedBody);
            if (bodyHeredocs !== undefined) markHeredocKeys(merged, bodyHeredocs);
            markHeredocKeys(merged, heredocKeys);
            finalArgs = merged;
        } else if (isRecord(finalArgs) && typeof parsedBody === "string" && attrs.content === undefined && attrs.text === undefined) {
            const merged: Record<string, unknown> = { ...finalArgs, content: parsedBody };
            const nextHeredocs = new Set<string>(heredocKeys);
            if (bodyMeta?.isTopHeredoc === true) nextHeredocs.add("content");
            markHeredocKeys(merged, nextHeredocs);
            finalArgs = merged;
        }
    }
    if (isRecord(finalArgs) && heredocKeys.size > 0) {
        markHeredocKeys(finalArgs, heredocKeys);
    }
    return [{
        chain,
        args: normalizeDecodedArgs(finalArgs, finalIsTopHeredoc),
        position,
    }];
};

export const scanMarkupIsland = (
    source: string,
    offset: number,
    index: SourceIndex,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    canDecodeWrapperSpan: (innerStart: number, innerEnd: number, defaultService?: string, isResultWrapper?: boolean, isSystem?: boolean) => boolean,
): MarkupScanResult | null => {
    if (source[offset] !== "<") return null;

    // Form A: Angle-bracketed or stuttered Code Mode hybrid (`<await plurnk.edit(...)/>`, `<tool<plurnk.edit(...)`, `<<plurnk.edit(...)`).
    const hybrid = scanAngleHybridCall(source, offset, index, executorSpellings);
    if (hybrid !== null) return hybrid;

    const slice = source.slice(offset);
    const position = index.positionAt(offset);

    // Form B: `<unfenced_code_edit_path>...</unfenced_code_edit_content>` triplet.
    const unfencedEdit = /^<unfenced_code_edit_path>([\s\S]*?)<\/unfenced_code_edit_path>\s*(?:<unfenced_code_edit_range>([\s\S]*?)<\/unfenced_code_edit_range>\s*)?(?:<unfenced_code_edit_pattern>([\s\S]*?)<\/unfenced_code_edit_pattern>\s*)?<unfenced_code_edit_content>([\s\S]*?)<\/unfenced_code_edit_content>/iu.exec(slice);
    if (unfencedEdit !== null) {
        const editArgs: Record<string, unknown> = { path: unfencedEdit[1].trim() };
        if (unfencedEdit[2] !== undefined && unfencedEdit[2].trim().length > 0) editArgs.range = unfencedEdit[2].trim();
        if (unfencedEdit[3] !== undefined && unfencedEdit[3].trim().length > 0) editArgs.pattern = unfencedEdit[3].trim();
        editArgs.content = unfencedEdit[4].replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
        return {
            kind: "calls",
            calls: [{ chain: ["plurnk", "edit"], args: [editArgs], position }],
            attemptText: unfencedEdit[0],
            position,
            defaultAside: null,
            endOffset: offset + unfencedEdit[0].length,
        };
    }

    // Form C: `<function=NAME>...</function>`.
    const fnEqualOpen = /^<function=([A-Za-z0-9_.:-]+)>/iu.exec(slice);
    if (fnEqualOpen !== null) {
        const fnBodyStart = offset + fnEqualOpen[0].length;
        const fnClose = findCloseSkippingHeredocs(source, fnBodyStart, "<\\/function>");
        if (fnClose !== null) {
            const rawFnName = fnEqualOpen[1].trim();
            const fnBodyMeta = parseXmlToolCallBodyWithMeta(source.slice(fnBodyStart, fnClose.innerEnd));
            const parsedFnBody = fnBodyMeta.value;
            const chain = resolveCallChain(rawFnName, executorSpellings);
            const calls = chain !== null
                ? [{ chain, args: normalizeDecodedArgs(parsedFnBody, fnBodyMeta.isTopHeredoc), position }]
                : extractProxyCalls(parsedFnBody, executorSpellings, position)
                    ?? (rawFnName.toLowerCase() === "plurnk"
                        ? [{ chain: ["plurnk", "plurnk"], args: normalizeDecodedArgs(parsedFnBody, fnBodyMeta.isTopHeredoc), position }]
                        : null);
            if (calls !== null && calls.length > 0) {
                return {
                    kind: "calls",
                    calls,
                    attemptText: source.slice(offset, fnClose.closeEnd),
                    position,
                    defaultAside: null,
                    endOffset: fnClose.closeEnd,
                };
            }
        }
    }

    // Form D: General XML / DSML / Wrapper / Direct Tool Element (`<TAG .../>`, `<TAG ...>...</TAG>`, or unclosed `<TAG ...>`).
    const tagOpenMatch = /^<(await\s+)?((?:[|｜]+)?DSML[|｜]+\s*[A-Za-z0-9_ -]+|DSML[|｜]+[A-Za-z0-9_ -]+|(?:[A-Za-z_$][A-Za-z0-9$]*[._:-])?(?:tool calls?(?:\s+pending)?|function calls?|tool use)|unfenced(?:\s+[A-Za-z0-9_-]+)?|mcp__[A-Za-z0-9_$-]+|[A-Za-z_$][A-Za-z0-9_$-]*(?:[._:-][A-Za-z_$][A-Za-z0-9_$-]*)?)(?=[\s/>])/iu.exec(slice);
    if (tagOpenMatch === null) return null;

    const hadAwaitPrefix = tagOpenMatch[1] !== undefined;
    const rawTag = tagOpenMatch[2];
    const cleanTagForWrapper = rawTag.replace(/^unfenced\s+.+$/iu, "unfenced").replace(/\s+pending$/iu, "");
    const tagLower = cleanTagForWrapper.toLowerCase();
    const isSystem = tagLower === "system";
    const wrapper = isSystem ? { isWrapper: false, defaultService: undefined } : parseWrapperTag(cleanTagForWrapper);
    const directChain = !isSystem && !wrapper.isWrapper
        ? resolveCallChain(rawTag, executorSpellings, true)
        : null;
    if (!isSystem && !wrapper.isWrapper && directChain === null) {
        return null;
    }

    const scannedAttrs = scanXmlAttributes(source, offset + tagOpenMatch[0].length, {
        isWrapper: wrapper.isWrapper,
        rawTag: cleanTagForWrapper,
        executorSpellings,
        defaultService: wrapper.defaultService,
    });
    if (scannedAttrs === null) return null;

    if (scannedAttrs.inlineCallCode !== undefined) {
        return {
            kind: "code",
            text: scannedAttrs.inlineCallCode.codeText,
            position,
            defaultAside: scannedAttrs.inlineCallCode.aside,
            endOffset: scannedAttrs.inlineCallCode.endOffset,
        };
    }

    const { attrs, heredocKeys, tagHeadEnd, selfClosing } = scannedAttrs;
    const nameKey = wrapper.isWrapper
        ? (["name", "call", "tool", "op"] as const).find((k) => typeof attrs[k] === "string")
        : undefined;
    const rawAttrName = nameKey !== undefined && typeof attrs[nameKey] === "string" ? attrs[nameKey] : undefined;

    if (selfClosing) {
        let endOffset = tagHeadEnd;
        if (!wrapper.isWrapper && !isSystem) {
            const escapedRaw = rawTag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
            const redundantClose = new RegExp(`^\\s*<\\/(?:await|${escapedRaw})>`, "iu").exec(source.slice(endOffset));
            if (redundantClose !== null) endOffset += redundantClose[0].length;
        }
        const restAttrs = { ...attrs };
        const restHeredocKeys = new Set(heredocKeys);
        if (nameKey !== undefined) {
            delete restAttrs[nameKey];
            restHeredocKeys.delete(nameKey);
        }
        const chain = wrapper.isWrapper
            ? (rawAttrName !== undefined ? resolveCallChain(rawAttrName, executorSpellings, false, wrapper.defaultService) : null)
            : directChain;
        if (chain === null) return null;
        const calls = buildNamedXmlCalls(chain, restAttrs, restHeredocKeys, undefined, executorSpellings, position, wrapper.defaultService);
        if (calls === null) return null;
        return {
            kind: "calls",
            calls,
            attemptText: source.slice(offset, endOffset),
            position,
            defaultAside: null,
            endOffset,
        };
    }

    // Open tag (`>`): check for a paired closing tag first.
    const matchedClose = findMatchingCloseTag(source, tagHeadEnd, rawTag, hadAwaitPrefix);
    if (matchedClose !== null) {
        const innerBody = source.slice(tagHeadEnd, matchedClose.innerEnd);
        const endOffset = matchedClose.closeEnd;

        if (isSystem) {
            if (canDecodeWrapperSpan(tagHeadEnd, matchedClose.innerEnd, undefined, false, true)) {
                return {
                    kind: "unwrap-span",
                    innerStart: tagHeadEnd,
                    innerEnd: matchedClose.innerEnd,
                    endOffset,
                    isSystem: true,
                };
            }
            return null;
        }

        if (wrapper.isWrapper && rawAttrName === undefined) {
            const isResultWrapper = tagLower === "result" || tagLower.endsWith("_result") || tagLower.endsWith(".result") || tagLower.endsWith(":result") || tagLower.endsWith("-result");
            if (
                isResultWrapper
                && /<output\b[^>]*>[\s\S]*?<\/output>/iu.test(innerBody)
                && !/<(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:arguments|args|parameters|params|input|parameter|param|arg|argument)\b/iu.test(innerBody)
            ) {
                return null;
            }
            const childCalls = decodeChildTagCalls(innerBody, executorSpellings, position, wrapper.defaultService, isResultWrapper);
            if (childCalls !== null) {
                return {
                    kind: "calls",
                    calls: childCalls,
                    attemptText: source.slice(offset, endOffset),
                    position,
                    defaultAside: null,
                    endOffset,
                };
            }
            if (canDecodeWrapperSpan(tagHeadEnd, matchedClose.innerEnd, wrapper.defaultService, isResultWrapper)) {
                return {
                    kind: "unwrap-span",
                    innerStart: tagHeadEnd,
                    innerEnd: matchedClose.innerEnd,
                    endOffset,
                    defaultService: wrapper.defaultService,
                };
            }
            return null;
        }

        const restAttrs = { ...attrs };
        const restHeredocKeys = new Set(heredocKeys);
        if (nameKey !== undefined) {
            delete restAttrs[nameKey];
            restHeredocKeys.delete(nameKey);
        }
        const rawVerb = cleanTagForWrapper.replace(/^(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|DSML[|｜]+|[A-Za-z_$][A-Za-z0-9$]*[._:-])/iu, "").trim();
        const chain = wrapper.isWrapper
            ? (rawAttrName !== undefined ? resolveCallChain(rawAttrName, executorSpellings, false, wrapper.defaultService) : null)
            : directChain;
        const calls = buildNamedXmlCalls(
            chain,
            restAttrs,
            restHeredocKeys,
            innerBody,
            executorSpellings,
            position,
            wrapper.defaultService,
            rawVerb,
        );
        if (calls === null) return null;
        return {
            kind: "calls",
            calls,
            attemptText: source.slice(offset, endOffset),
            position,
            defaultAside: null,
            endOffset,
        };
    }

    // Unclosed tag (`<plurnk.wait seconds="30">`, `<plurnk.edit ... text="<<<EOF\n...\nEOF">`, or unclosed prefix `<tool_call> ...`).
    if (directChain !== null) {
        // Direct `<plurnk.<op> ...>` or `<svc_tool ...>` with heredoc attributes or bare `<plurnk.<op> ...>` on its own line.
        const isPlurnkDirect = directChain[0] === "plurnk" && rawTag.toLowerCase().startsWith("plurnk");
        const restOfLine = source.slice(tagHeadEnd, (() => {
            const nl = source.indexOf("\n", tagHeadEnd);
            return nl === -1 ? source.length : nl;
        })()).trim();
        if (heredocKeys.size > 0 || (isPlurnkDirect && restOfLine === "")) {
            const calls = buildNamedXmlCalls(directChain, attrs, heredocKeys, undefined, executorSpellings, position);
            if (calls !== null) {
                return {
                    kind: "calls",
                    calls,
                    attemptText: source.slice(offset, tagHeadEnd),
                    position,
                    defaultAside: null,
                    endOffset: tagHeadEnd,
                };
            }
        }
        return null;
    }

    if (wrapper.isWrapper && rawAttrName !== undefined && heredocKeys.size > 0) {
        const restAttrs = { ...attrs };
        const restHeredocKeys = new Set(heredocKeys);
        if (nameKey !== undefined) {
            delete restAttrs[nameKey];
            restHeredocKeys.delete(nameKey);
        }
        const chain = resolveCallChain(rawAttrName, executorSpellings, false, wrapper.defaultService);
        if (chain !== null) {
            const calls = buildNamedXmlCalls(chain, restAttrs, restHeredocKeys, undefined, executorSpellings, position, wrapper.defaultService);
            if (calls !== null) {
                return {
                    kind: "calls",
                    calls,
                    attemptText: source.slice(offset, tagHeadEnd),
                    position,
                    defaultAside: null,
                    endOffset: tagHeadEnd,
                };
            }
        }
    }

    // Unclosed wrapper prefix (`<tool_call>`, `<TOOLCALL>`, `<function_call>`).
    if (wrapper.isWrapper && rawAttrName === undefined && /^(?:tool_calls?|toolcalls?|function_calls?|unfenced)$/iu.test(tagLower)) {
        return decodeUnclosedPrefixPayload(source, tagHeadEnd, index, executorSpellings, wrapper.defaultService);
    }

    return null;
};

export const decodeUnclosedPrefixPayload = (
    source: string,
    afterPrefix: number,
    index: SourceIndex,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
): MarkupScanResult | null => {
    let pos = afterPrefix;
    // Skip any stacked repeated prefix tags (`<tool_call><tool_call>`, `<|tool_call|>`).
    while (pos < source.length) {
        while (pos < source.length && (source[pos] === " " || source[pos] === "\t")) pos += 1;
        const stacked = /^(?:<(?:tool_calls?|TOOLCALL|function_calls?)\b[^>]*>|<\|tool_call[^>]*>|<\|python_tag\|>|\[TOOL_CALLS\])/iu.exec(source.slice(pos));
        if (stacked !== null && findMatchingCloseTag(source, pos + stacked[0].length, "tool_call", false) === null) {
            pos += stacked[0].length;
            continue;
        }
        break;
    }
    const nlMatch = /^[ \t]*\r?\n/u.exec(source.slice(pos));
    if (nlMatch !== null) pos += nlMatch[0].length;
    while (pos < source.length && (source[pos] === " " || source[pos] === "\t")) pos += 1;
    if (pos >= source.length) return null;

    const payloadPos = index.positionAt(pos);

    // 1. JSON / Code-Mode-with-heredoc object or array (`{"name":"plurnk.edit","arguments":{...,"text":<<<EOF...EOF}})`).
    if (source[pos] === "{" || source[pos] === "[") {
        const valParsed = parseValuePrefix(source, pos);
        if (valParsed !== null) {
            let endOffset = valParsed.endOffset;
            const strayParenOrClose = /^(?:[ \t]*[);])*[ \t]*(?:<\/(?:tool_calls?|TOOLCALL|function_calls?)>|<\|\/tool_call\|>|\[\/TOOL_CALLS\]|<\/?\|(?:begin|end)\|>)*[ \t]*/iu.exec(source.slice(endOffset));
            if (strayParenOrClose !== null) endOffset += strayParenOrClose[0].length;
            const calls = decodeJsonOrValueCalls(source.slice(pos, valParsed.endOffset), executorSpellings, payloadPos, defaultService);
            if (calls !== null && calls.length > 0) {
                return {
                    kind: "calls",
                    calls,
                    attemptText: source.slice(pos, endOffset),
                    position: payloadPos,
                    defaultAside: null,
                    endOffset,
                };
            }
        }
    }

    // 2. Bracketed Pythonic or Code Mode call (`[plurnk.read(path="d.ts")]` or `[await plurnk.done(...)]`).
    if (source[pos] === "[") {
        const pyCalls = decodePythonicCalls(source.slice(pos), executorSpellings, payloadPos, defaultService, true);
        if (pyCalls !== null) {
            let endOffset = pos + pyCalls.endOffset;
            const trailingTok = /^[ \t]*(?:<\|tool_call[_:]end\|>|\[\/TOOL_CALLS\]|<\/tool_call>|<\/?\|(?:begin|end)\|>|<\|(?:start|channel)\|>[^\r\n]*)+/iu.exec(source.slice(endOffset));
            if (trailingTok !== null) endOffset += trailingTok[0].length;
            return {
                kind: "calls",
                calls: pyCalls.calls,
                attemptText: source.slice(pos, pos + pyCalls.endOffset),
                position: payloadPos,
                defaultAside: null,
                endOffset,
            };
        }
    }

    // 3. `name` + `<arg_key>` / `<param_key>` pairs (`<|tool_call|>edit\n<arg_key>...` or `<tool_call> read<param_key>...`).
    const glmHead = /^([A-Za-z0-9_.:-]+)[ \t]*\r?\n?(?=[ \t]*<(?:arg|param|parameter)_key\b)/iu.exec(source.slice(pos));
    if (glmHead !== null) {
        const chain = resolveCallChain(glmHead[1], executorSpellings, false, defaultService);
        if (chain !== null) {
            let pairCursor = pos + glmHead[0].length;
            let matchedAnyPair = false;
            while (pairCursor < source.length) {
                const pairOpen = /^[ \t\r\n]*<(?:arg|param|parameter)_key\b[^>]*>[\s\S]*?<\/(?:arg|param|parameter)_key>[ \t]*\r?\n?[ \t]*<(?:arg|param|parameter)_value\b[^>]*>/iu.exec(source.slice(pairCursor));
                if (pairOpen === null) break;
                const valStart = pairCursor + pairOpen[0].length;
                const valClose = findCloseSkippingHeredocs(source, valStart, "<\\/(?:arg|param|parameter)_value>");
                if (valClose === null) break;
                matchedAnyPair = true;
                pairCursor = valClose.closeEnd;
            }
            if (matchedAnyPair) {
                const parsedArgs = parseXmlToolCallBody(source.slice(pos + glmHead[0].length, pairCursor));
                const trailingClose = /^[ \t]*\r?\n?[ \t]*<\/tool_call>/iu.exec(source.slice(pairCursor));
                const endOffset = pairCursor + (trailingClose !== null ? trailingClose[0].length : 0);
                return {
                    kind: "calls",
                    calls: [{ chain, args: normalizeDecodedArgs(parsedArgs), position: payloadPos }],
                    attemptText: source.slice(pos, endOffset),
                    position: payloadPos,
                    defaultAside: null,
                    endOffset,
                };
            }
        }
    }

    // 4. `name` + `{...}` object (`<|tool_call|>plurnk.note\n{"text":...}` or `<tool_call> read{"path":...} // aside`).
    const glmObjHead = /^([A-Za-z0-9_.:-]+)[ \t]*\r?\n?(?=\{)/iu.exec(source.slice(pos));
    if (glmObjHead !== null) {
        const chain = resolveCallChain(glmObjHead[1], executorSpellings, false, defaultService);
        const valParsed = parseValuePrefix(source, pos + glmObjHead[0].length);
        if (chain !== null && valParsed !== null && isRecord(valParsed.value)) {
            let endOffset = valParsed.endOffset;
            while (endOffset < source.length && (source[endOffset] === " " || source[endOffset] === "\t")) endOffset += 1;
            let defaultAside: string | null = null;
            if (source[endOffset] === "/" && source[endOffset + 1] === "/") {
                const { aside, endOffset: commentEnd } = readTrailingAside(source, endOffset + 2);
                defaultAside = aside.length > 0 ? aside : null;
                endOffset = commentEnd;
            }
            return {
                kind: "calls",
                calls: [{ chain, args: [valParsed.value], position: payloadPos }],
                attemptText: source.slice(pos, endOffset),
                position: payloadPos,
                defaultAside,
                endOffset,
            };
        }
    }

    // 5. Inner Code Mode call (`<tool_call> await plurnk.edit(...)` or `<|tool_call:start|>plurnk.read(...)`).
    if (/^(?:\[\s*)?(?:await\s+[A-Za-z_$(]|plurnk\b|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.|\(|\[))/iu.test(source.slice(pos))) {
        let innerStart = pos;
        if (source[innerStart] === "[") {
            innerStart += 1;
            while (innerStart < source.length && (source[innerStart] === " " || source[innerStart] === "\t")) innerStart += 1;
        }
        return {
            kind: "unwrap-prefix",
            innerOffset: innerStart,
        };
    }

    return null;
};
