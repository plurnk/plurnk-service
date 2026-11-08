import {
    isRecord,
    type Position,
    type RuntimeTag,
} from "@plurnk/plurnk-contracts";
import { maskHeredocBodies, matchHeredocOpener, unmaskHeredocBodies } from "./HeredocSyntax.ts";
import {
    EDIT_KEYS,
    IGNORED_OPTION_KEYS,
    NOTE_KEYS,
    TODO_KEYS,
} from "./OptionCoercion.ts";
import {
    formatTranslatedCall,
    padNewlines,
    parseWrapperTag,
    parseXmlToolCallBody,
    replaceXmlInvocations,
    resolveToolCallTarget,
    translateXmlToolCalls,
    tryTranslateChildTagCall,
    unescapeXmlAttrValue,
} from "./XmlEnvelopes.ts";

export { resolveToolCallTarget };

export const CODE_LINE_START = /^ {0,3}(?:\(+\s*(?:await\s+[A-Za-z_$]|plurnk\b|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\()|await\s+[A-Za-z_$(]|plurnk\b|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(|(?:const|let|var|for|while|if|switch|try|function)\b|\/\/|\/\*)/u;
export const CODE_CONTINUATION_START = /^[ \t]*(?:\(+\s*(?:await\s+[A-Za-z_$]|plurnk\b|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\()|await\s+[A-Za-z_$(]|plurnk\b|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(|(?:const|let|var|for|while|if|switch|try|function)\b|\/\/|\/\*)/u;
export const CONTAINS_CALL = /\bplurnk\s*(?:\.|\[|\()|\bawait\s+[A-Za-z_$][A-Za-z0-9_$-]*\s*\(|(?:await\s+)?[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(/u;

const extractToolCallDescriptors = (val: unknown): Array<{ readonly name: string; readonly args: unknown }> | null => {
    if (Array.isArray(val)) {
        if (val.length === 0) return null;
        const all: Array<{ readonly name: string; readonly args: unknown }> = [];
        for (const item of val) {
            const sub = extractToolCallDescriptors(item);
            if (sub === null) return null;
            all.push(...sub);
        }
        return all;
    }
    if (!isRecord(val)) return null;
    if (isRecord(val.function) && typeof val.function.name === "string") {
        return [{
            name: val.function.name,
            args: val.function.arguments ?? val.function.parameters ?? val.function.input ?? val.function.args ?? {},
        }];
    }
    const explicitArgs = val.arguments ?? val.parameters ?? val.input ?? val.args;
    const rawName = val.name ?? val.tool ?? val.tool_name ?? (explicitArgs !== undefined ? val.command : undefined);
    if (typeof rawName === "string") {
        if (explicitArgs !== undefined) {
            return [{ name: rawName, args: explicitArgs }];
        }
        const restArgs: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
            if (k !== "name" && k !== "tool" && k !== "tool_name" && k !== "type" && !IGNORED_OPTION_KEYS.has(k)) {
                restArgs[k] = v;
            }
        }
        return [{
            name: rawName,
            args: Object.keys(restArgs).length > 0 ? restArgs : {},
        }];
    }
    const keys = Object.keys(val).filter((k) => !IGNORED_OPTION_KEYS.has(k));
    const hasPathKey = keys.some((k) => k === "path" || k === "target" || k === "uri" || k === "file_path" || k === "filepath" || k === "file");
    const hasEditPayloadKey = keys.some((k) => k === "text" || k === "content" || k === "body" || k === "newText" || k === "new_string" || k === "new_text" || k === "replacement" || k === "edits");
    if (hasPathKey && hasEditPayloadKey && keys.every((k) => EDIT_KEYS.has(k))) {
        return [{ name: "plurnk.edit", args: val }];
    }
    if (!hasPathKey && (typeof val.text === "string" || typeof val.note === "string") && keys.every((k) => NOTE_KEYS.has(k))) {
        return [{ name: "plurnk.note", args: val }];
    }
    if (!hasPathKey && (val.items !== undefined || val.todos !== undefined) && keys.every((k) => TODO_KEYS.has(k))) {
        return [{ name: "plurnk.todo", args: val }];
    }
    return null;
};

const translateJsonToolCalls = (
    rawJson: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
): string | null => {
    const trimmed = rawJson.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    const parsedValues: unknown[] = [];
    try {
        parsedValues.push(JSON.parse(trimmed));
    } catch {
        const lines = trimmed.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.length > 0);
        if (lines.length <= 1) return null;
        try {
            for (const line of lines) parsedValues.push(JSON.parse(line));
        } catch {
            return null;
        }
    }
    const calls: string[] = [];
    for (const val of parsedValues) {
        const descriptors = extractToolCallDescriptors(val);
        if (descriptors === null || descriptors.length === 0) return null;
        for (const { name, args } of descriptors) {
            const target = resolveToolCallTarget(name, executorSpellings, false, defaultService);
            if (target === null) return null;
            calls.push(formatTranslatedCall(target, args));
        }
    }
    return calls.length > 0 ? calls.join("\n") : null;
};

// Scans a balanced JSON object or array starting at `startOffset` (ignoring blank lines inside JSON strings).
const extractBalancedJsonPrefix = (
    text: string,
    startOffset: number,
): { readonly json: string; readonly endOffset: number } | null => {
    let i = startOffset;
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === "\n")) {
        i += 1;
    }
    const openChar = text[i];
    if (openChar !== "{" && openChar !== "[") return null;
    const start = i;
    let depth = 0;
    let inString = false;
    while (i < text.length) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") {
                i += 2;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            i += 1;
            continue;
        }
        if (ch === '"') {
            inString = true;
            i += 1;
            continue;
        }
        if (ch === "{" || ch === "[") {
            depth += 1;
        } else if (ch === "}" || ch === "]") {
            depth -= 1;
            if (depth === 0) {
                return {
                    json: text.slice(start, i + 1),
                    endOffset: i + 1,
                };
            }
        }
        i += 1;
    }
    return null;
};

const splitTopLevelCommaItems = (input: string): string[] | null => {
    const items: string[] = [];
    let currentStart = 0;
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let inQuote: '"' | "'" | '"""' | "'''" | null = null;
    let i = 0;
    while (i < input.length) {
        if (inQuote !== null) {
            if (input[i] === "\\") {
                i += 2;
                continue;
            }
            if (inQuote.length === 3 && input.startsWith(inQuote, i)) {
                inQuote = null;
                i += 3;
                continue;
            }
            if (inQuote.length === 1 && input[i] === inQuote) {
                inQuote = null;
                i += 1;
                continue;
            }
            i += 1;
            continue;
        }
        if (input.startsWith('"""', i)) {
            inQuote = '"""';
            i += 3;
            continue;
        }
        if (input.startsWith("'''", i)) {
            inQuote = "'''";
            i += 3;
            continue;
        }
        const ch = input[i];
        if (ch === '"' || ch === "'") {
            inQuote = ch;
            i += 1;
            continue;
        }
        if (ch === "(") parenDepth += 1;
        else if (ch === ")") {
            if (parenDepth === 0) return null;
            parenDepth -= 1;
        } else if (ch === "{") braceDepth += 1;
        else if (ch === "}") {
            if (braceDepth === 0) return null;
            braceDepth -= 1;
        } else if (ch === "[") bracketDepth += 1;
        else if (ch === "]") {
            if (bracketDepth === 0) return null;
            bracketDepth -= 1;
        } else if (ch === "," && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
            const slice = input.slice(currentStart, i).trim();
            if (slice.length > 0) items.push(slice);
            currentStart = i + 1;
        }
        i += 1;
    }
    if (inQuote !== null || parenDepth !== 0 || braceDepth !== 0 || bracketDepth !== 0) {
        return null;
    }
    const tail = input.slice(currentStart).trim();
    if (tail.length > 0) items.push(tail);
    return items;
};

const parsePythonLiteralValue = (raw: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
    const trimmed = raw.trim();
    if (trimmed === "True" || trimmed === "true") return { ok: true, value: true };
    if (trimmed === "False" || trimmed === "false") return { ok: true, value: false };
    if (trimmed === "None" || trimmed === "null") return { ok: true, value: null };
    if (/^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(trimmed)) {
        return { ok: true, value: Number(trimmed) };
    }
    if ((trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length >= 6)
        || (trimmed.startsWith("'''") && trimmed.endsWith("'''") && trimmed.length >= 6)) {
        return { ok: true, value: unescapeXmlAttrValue(trimmed.slice(3, -3), null) };
    }
    if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
        || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
        const q = trimmed[0] === '"' ? '"' : "'";
        return { ok: true, value: unescapeXmlAttrValue(trimmed.slice(1, -1), q) };
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const innerItems = splitTopLevelCommaItems(trimmed.slice(1, -1));
        if (innerItems === null) return { ok: false };
        const arr: unknown[] = [];
        for (const item of innerItems) {
            const parsed = parsePythonLiteralValue(item);
            if (!parsed.ok) return { ok: false };
            arr.push(parsed.value);
        }
        return { ok: true, value: arr };
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
            return { ok: true, value: JSON.parse(trimmed) };
        } catch {
            return { ok: false };
        }
    }
    return { ok: false };
};

// Liquid AI LFM-2 / LFM-3 Pythonic tool call transducer: `[func(k="v", n=1)]` -> `await plurnk.func({"k":"v","n":1})`.
const translatePythonicToolCalls = (
    rawText: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
): string | null => {
    let trimmed = rawText.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const inside = trimmed.slice(1, -1).trim();
        if (!/^(?:await\s+)?[A-Za-z_$]/u.test(inside)) return null;
        trimmed = inside;
    }
    const callStrings = splitTopLevelCommaItems(trimmed);
    if (callStrings === null || callStrings.length === 0) return null;
    const translatedCalls: string[] = [];
    for (const callStr of callStrings) {
        const callMatch = /^(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$.:-]*)\s*\(([\s\S]*)\);?$/u.exec(callStr);
        if (callMatch === null) return null;
        const target = resolveToolCallTarget(callMatch[1], executorSpellings, false, defaultService);
        if (target === null) return null;
        const argsBody = callMatch[2].trim();
        if (argsBody.length === 0) {
            translatedCalls.push(`${target}()`);
            continue;
        }
        const argItems = splitTopLevelCommaItems(argsBody);
        if (argItems === null || argItems.length === 0) return null;
        if (argItems.length === 1 && !/^[A-Za-z_][A-Za-z0-9_]*\s*=/u.test(argItems[0])) {
            const singleVal = parsePythonLiteralValue(argItems[0]);
            if (!singleVal.ok) return null;
            translatedCalls.push(formatTranslatedCall(target, singleVal.value));
            continue;
        }
        const kwargsObj: Record<string, unknown> = {};
        for (const item of argItems) {
            const kwMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/u.exec(item);
            if (kwMatch === null) return null;
            const parsedVal = parsePythonLiteralValue(kwMatch[2]);
            if (!parsedVal.ok) return null;
            kwargsObj[kwMatch[1]] = parsedVal.value;
        }
        translatedCalls.push(formatTranslatedCall(target, kwargsObj));
    }
    return translatedCalls.length > 0 ? translatedCalls.join("\n") : null;
};

const unwrapWrapperInnerCalls = (
    inner: string,
    fullMatch: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
    isResultWrapper = false,
): string => {
    const childTranslated = tryTranslateChildTagCall(inner, executorSpellings, defaultService, isResultWrapper);
    if (childTranslated !== null) {
        return padNewlines(childTranslated, fullMatch);
    }
    const xmlTranslated = translateXmlToolCalls(inner, executorSpellings, defaultService);
    if (xmlTranslated !== null) {
        return padNewlines(xmlTranslated, fullMatch);
    }
    const jsonTranslated = translateJsonToolCalls(inner, executorSpellings, defaultService);
    if (jsonTranslated !== null) {
        return padNewlines(jsonTranslated, fullMatch);
    }
    const pythonicTranslated = translatePythonicToolCalls(inner, executorSpellings, defaultService);
    if (pythonicTranslated !== null) {
        return padNewlines(pythonicTranslated, fullMatch);
    }
    const unbackticked = inner.replace(/^[ \t]*`((?:await\s+)?[A-Za-z_$][\s\S]*?)`[ \t]*$/gmu, "$1");
    if (CONTAINS_CALL.test(unbackticked)) {
        return padNewlines(unbackticked.replace(/^\r?\n/u, "\n"), fullMatch);
    }
    return fullMatch;
};

// Translates Mistral Tekken v7+ `[TOOL_CALLS]func_name[ARGS]{...}` and unclosed prefix envelopes (`<|tool_call|>`, `<tool_call>`, `<|python_tag|>`, `[TOOL_CALLS]`) using balanced JSON extraction.
const translatePrefixEnvelopeCalls = (
    input: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
): string => {
    // 1. Mistral Tekken v7+ `[TOOL_CALLS]func_name[ARGS]{...}` (including chained `func_name[ARGS]{...}`)
    let out = input;
    const mistralMarkerRe = /\[TOOL_CALLS\][ \t]*([A-Za-z0-9_.:-]+)[ \t]*\[ARGS\][ \t]*/giu;
    let m: RegExpExecArray | null;
    let mistralCursor = 0;
    let mistralRebuilt = "";
    while ((m = mistralMarkerRe.exec(out)) !== null) {
        if (m.index < mistralCursor) continue;
        const calls: string[] = [];
        let scanPos = m.index + m[0].length;
        let currentName: string | null = m[1];
        let lastEnd = m.index;
        while (currentName !== null) {
            const target = resolveToolCallTarget(currentName, executorSpellings);
            const balanced = extractBalancedJsonPrefix(out, scanPos);
            if (target === null || balanced === null) break;
            let parsedArgs: unknown;
            try {
                parsedArgs = JSON.parse(balanced.json);
            } catch {
                break;
            }
            calls.push(formatTranslatedCall(target, parsedArgs));
            lastEnd = balanced.endOffset;
            const nextSlice = out.slice(lastEnd);
            const chainedMatch = /^[ \t]*(?:\[TOOL_CALLS\])?[ \t]*([A-Za-z0-9_.:-]+)[ \t]*\[ARGS\][ \t]*/iu.exec(nextSlice);
            if (chainedMatch !== null) {
                currentName = chainedMatch[1];
                scanPos = lastEnd + chainedMatch[0].length;
            } else {
                currentName = null;
            }
        }
        if (calls.length > 0) {
            const originalSpan = out.slice(m.index, lastEnd);
            mistralRebuilt += out.slice(mistralCursor, m.index) + padNewlines(calls.join("\n"), originalSpan);
            mistralCursor = lastEnd;
            mistralMarkerRe.lastIndex = lastEnd;
        }
    }
    if (mistralCursor > 0) {
        out = mistralRebuilt + out.slice(mistralCursor);
    }

    // 2. Unclosed GLM-4.5 `<|tool_call|>name\n<arg_key>...</arg_key><arg_value>...</arg_value>`
    out = out.replace(
        /^[ \t]*<\|tool_call\|>[ \t]*([A-Za-z0-9_.:-]+)[ \t]*(\r?\n)((?:[ \t]*<arg_key\b[^>]*>[\s\S]*?<\/arg_key>[ \t]*\r?\n?[ \t]*<arg_value\b[^>]*>[\s\S]*?<\/arg_value>[ \t]*\r?\n?)+)/gimu,
        (fullMatch, rawName: string, nl: string, xmlArgs: string) => {
            const target = resolveToolCallTarget(rawName, executorSpellings);
            if (target === null) return fullMatch;
            return padNewlines(`${nl}${formatTranslatedCall(target, parseXmlToolCallBody(xmlArgs))}`, fullMatch);
        },
    );

    // 3. Unclosed GLM-4 `<|tool_call|>name\n{...}` with balanced JSON object scanning
    const glmPrefixRe = /^[ \t]*<\|tool_call\|>[ \t]*([A-Za-z0-9_.:-]+)[ \t]*(\r?\n)/gimu;
    let glmCursor = 0;
    let glmRebuilt = "";
    while ((m = glmPrefixRe.exec(out)) !== null) {
        if (m.index < glmCursor) continue;
        const target = resolveToolCallTarget(m[1], executorSpellings);
        const balanced = extractBalancedJsonPrefix(out, m.index + m[0].length);
        if (target === null || balanced === null || !balanced.json.startsWith("{")) continue;
        const originalSpan = out.slice(m.index, balanced.endOffset);
        const nl = m[2] ?? "\n";
        const replacement = padNewlines(`${nl}${formatTranslatedCall(target, parseXmlToolCallBody(balanced.json))}`, originalSpan);
        glmRebuilt += out.slice(glmCursor, m.index) + replacement;
        glmCursor = balanced.endOffset;
        glmPrefixRe.lastIndex = balanced.endOffset;
    }
    if (glmCursor > 0) {
        out = glmRebuilt + out.slice(glmCursor);
    }

    // 4. Unclosed `<|tool_call|>`, `<tool_call>`, `<TOOLCALL>`, `<|python_tag|>`, `[TOOL_CALLS]` followed by balanced JSON `{...}` / `[...]`
    const jsonPrefixRe = /^[ \t]*(?:<tool_call\b[^>]*>|<TOOLCALL\b[^>]*>|<\|python_tag\|>|<\|tool_call[^>]*>|\[TOOL_CALLS\])[ \t]*(\r?\n)?/gimu;
    let jsonCursor = 0;
    let jsonRebuilt = "";
    while ((m = jsonPrefixRe.exec(out)) !== null) {
        if (m.index < jsonCursor) continue;
        const afterPrefix = m.index + m[0].length;
        const balanced = extractBalancedJsonPrefix(out, afterPrefix);
        if (balanced === null) continue;
        let endOffset = balanced.endOffset;
        const trailingClose = /^[ \t]*(?:<\/tool_call>|<\/TOOLCALL>|<\|\/tool_call\|>|\[\/TOOL_CALLS\])/iu.exec(out.slice(endOffset));
        if (trailingClose !== null) {
            endOffset += trailingClose[0].length;
        }
        const jsonTranslated = translateJsonToolCalls(balanced.json, executorSpellings);
        if (jsonTranslated === null) continue;
        const originalSpan = out.slice(m.index, endOffset);
        const prefixNewline = m[1] ?? "";
        jsonRebuilt += out.slice(jsonCursor, m.index) + padNewlines(`${prefixNewline}${jsonTranslated}`, originalSpan);
        jsonCursor = endOffset;
        jsonPrefixRe.lastIndex = endOffset;
    }
    if (jsonCursor > 0) {
        out = jsonRebuilt + out.slice(jsonCursor);
    }

    // 5. Fallback for unclosed `<|python_tag|>` / `<|tool_call|>` followed by Pythonic or Code Mode call on the same paragraph
    out = out.replace(
        /^[ \t]*(?:<tool_call\b[^>]*>|<TOOLCALL\b[^>]*>|<\|python_tag\|>|<\|tool_call[^>]*>|\[TOOL_CALLS\])[ \t]*(\r?\n)?([ \t]*(?:\[[A-Za-z_$][\s\S]*?\]|(?:await\s+)?[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])?\s*\([\s\S]*?))(?=\r?\n\r?\n|$)/gmu,
        (fullMatch, nl: string | undefined, payload: string) => {
            const prefixNewline = nl ?? "";
            const cleanedPayload = payload.replace(/[ \t]*(?:<\/tool_call>|<\/TOOLCALL>|<\|\/tool_call\|>|\[\/TOOL_CALLS\])[ \t]*$/iu, "");
            const pythonicTranslated = translatePythonicToolCalls(cleanedPayload, executorSpellings);
            if (pythonicTranslated !== null) {
                return padNewlines(`${prefixNewline}${pythonicTranslated}`, fullMatch);
            }
            if (CONTAINS_CALL.test(cleanedPayload)) {
                return padNewlines(`${prefixNewline}${cleanedPayload}`, fullMatch);
            }
            return fullMatch;
        },
    );

    return out;
};

export const translateSegmentToolCalls = (segment: string, executorSpellings: ReadonlyMap<string, RuntimeTag>): string => {
    let out = segment.replace(
        /<((?:[|｜]+)?DSML[|｜]+\s*(?:function_calls?|tool_calls?|calls)|(?:[A-Za-z_$][A-Za-z0-9$]*[._:-])?(?:invoke|call|calls|tool|tools|toolcall|toolcalls|tool_call|tool_calls|tool-call|tool-calls|tool calls?|tool_use|tool-use|tool use|tool_code|function|functions|functioncall|functioncalls|function_call|function_calls|function-call|function-calls|function calls?|emission|result|unfenced)|system)\b(?![^>]*\b(?:name|call|tool|op)\s*=)[^>]*>([\s\S]*?)<\/\1>|<[|｜]tool[▁_]calls(?:_section)?[▁_]begin[|｜]>([\s\S]*?)<[|｜]tool[▁_]calls(?:_section)?[▁_]end[|｜]>|<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>|<\|tool_call[^>]*>([\s\S]*?)<\|\/tool_call\|>|\[TOOL_CALLS\]([\s\S]*?)\[\/TOOL_CALLS\]/giu,
        (
            fullMatch,
            rawTag: string | undefined,
            inner1: string | undefined,
            inner2: string | undefined,
            inner3: string | undefined,
            inner4: string | undefined,
            inner5: string | undefined,
        ) => {
            const inner = inner1 ?? inner2 ?? inner3 ?? inner4 ?? inner5 ?? "";
            const tagLower = (rawTag ?? "").toLowerCase();
            if (tagLower === "system") {
                const unbackticked = inner.replace(/^[ \t]*`((?:await\s+)?[A-Za-z_$][\s\S]*?)`[ \t]*$/gmu, "$1");
                if (CONTAINS_CALL.test(unbackticked)) {
                    return padNewlines(unbackticked.replace(/^\r?\n/u, "\n"), fullMatch);
                }
                return fullMatch;
            }
            const { defaultService } = rawTag !== undefined ? parseWrapperTag(rawTag) : { defaultService: undefined };
            const isResultWrapper = tagLower === "result" || tagLower.endsWith("_result") || tagLower.endsWith(".result") || tagLower.endsWith(":result") || tagLower.endsWith("-result");
            return unwrapWrapperInnerCalls(inner, fullMatch, executorSpellings, defaultService, isResultWrapper);
        },
    );

    const xmlReplaced = replaceXmlInvocations(out, executorSpellings);
    out = xmlReplaced.text;
    if (xmlReplaced.translated) {
        out = out.replace(
            /^[ \t]*<\/?(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:tool[ _-]?calls?|function[ _-]?calls?|(?:function_)?calls|unfenced|result)\b[^>]*>[ \t]*$/gimu,
            "",
        );
    } else if (CONTAINS_CALL.test(out)) {
        out = out.replace(
            /^[ \t]*<\/?(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:tool[ _-]?calls?|function[ _-]?calls?)\b[^>]*>[ \t]*$/gimu,
            "",
        );
    }

    // Unwrap standalone single-backticked Code Mode call lines (`await plurnk.<op>(...)`).
    out = out.replace(
        /^[ \t]*`((?:await\s+)?[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\([^\r\n`]*?\)\s*;?)`([ \t]*(?:\/\/[^\r\n]*)?)$/gmu,
        (fullMatch, callExpr: string, trailingComment: string) => {
            const headMatch = /^(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$-]*\s*\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|plurnk\b)/u.exec(callExpr.trim());
            if (headMatch === null) return fullMatch;
            const rawTarget = headMatch[1].replace(/\s+/gu, "");
            if (rawTarget !== "plurnk" && resolveToolCallTarget(rawTarget, executorSpellings, true) === null) {
                return fullMatch;
            }
            return `${callExpr}${trailingComment}`;
        },
    );

    return translatePrefixEnvelopeCalls(out, executorSpellings);
};

// Pre-scan Markdown fences that wrap Code Mode statements so fenced Code Mode unwraps with a warning,
// while non-Code-Mode fenced blocks in outside prose (or inside multiline string literals or heredocs) remain untouched.
export const unwrapCodeModeFences = (
    input: string,
    executorSpellings?: ReadonlyMap<string, RuntimeTag>,
): {
    readonly source: string;
    readonly advisories: ReadonlyArray<{ readonly position: Position; readonly message: string }>;
} => {
    const lines = input.split("\n");
    const advisories: Array<{ readonly position: Position; readonly message: string }> = [];
    let inString: '"' | "'" | "`" | null = null;
    let parenDepth = 0;
    const pendingHeredocs: string[] = [];
    const advanceLineState = (line: string): void => {
        for (let k = 0; k < line.length; k += 1) {
            const ch = line[k];
            if (inString !== null) {
                if (ch === "\\") {
                    k += 1;
                    continue;
                }
                if (ch === inString) inString = null;
                continue;
            }
            if (ch === "/" && line[k + 1] === "/") break;
            if (ch === "<" && line[k + 1] === "<") {
                const opener = matchHeredocOpener(line, k);
                if (opener !== null) {
                    pendingHeredocs.push(opener.tag);
                    k = opener.afterOpener - 1;
                    continue;
                }
            }
            if (ch === '"' || ch === "'" || ch === "`") {
                inString = ch;
            } else if (ch === "(") {
                parenDepth += 1;
            } else if (ch === ")" && parenDepth > 0) {
                parenDepth -= 1;
            }
        }
    };
    let i = 0;
    while (i < lines.length) {
        if (pendingHeredocs.length > 0) {
            const tag = pendingHeredocs[0];
            const cleanLine = lines[i].replace(/\r$/u, "");
            let wsLen = 0;
            while (wsLen < cleanLine.length && (cleanLine[wsLen] === " " || cleanLine[wsLen] === "\t")) wsLen += 1;
            if (cleanLine.startsWith(tag, wsLen) && /^[ \t]*(?:[,}\]);+]|\/\/|\/\*|$)/u.test(cleanLine.slice(wsLen + tag.length))) {
                pendingHeredocs.shift();
                advanceLineState(cleanLine.slice(wsLen + tag.length));
            }
            i += 1;
            continue;
        }
        if (inString !== null || parenDepth > 0) {
            advanceLineState(lines[i]);
            i += 1;
            continue;
        }
        // Cohere Command R / Command A style: `Action: ```json\n[...]\n````
        const cohereActionMatch = executorSpellings !== undefined
            ? /^( {0,3})Action:[ \t]*(`{3,}|~{3,})([^\n`~]*)\r?$/iu.exec(lines[i])
            : null;
        const openMatch = cohereActionMatch ?? /^( {0,3})(`{3,}|~{3,})([^\n`~]*)\r?$/u.exec(lines[i]);
        if (openMatch === null) {
            if (CODE_LINE_START.test(lines[i])) {
                advanceLineState(lines[i]);
            }
            i += 1;
            continue;
        }
        const fence = openMatch[2];
        const fenceChar = fence[0];
        const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fence.length},}[ \\t]*\\r?$`, "u");
        let closeIdx = -1;
        for (let j = i + 1; j < lines.length; j += 1) {
            if (closeRe.test(lines[j])) {
                closeIdx = j;
                break;
            }
        }
        if (closeIdx === -1) {
            i += 1;
            continue;
        }
        const inner = lines.slice(i + 1, closeIdx).join("\n");
        const lang = (openMatch[3].trim().split(/\s+/u)[0] ?? "").toLowerCase();
        if (cohereActionMatch !== null && executorSpellings !== undefined) {
            const jsonTranslated = translateJsonToolCalls(inner, executorSpellings);
            if (jsonTranslated !== null) {
                lines[i] = "";
                const translatedLines = jsonTranslated.split("\n");
                for (let j = i + 1; j <= closeIdx; j += 1) {
                    lines[j] = translatedLines[j - (i + 1)] ?? "";
                }
                if (translatedLines.length > closeIdx - i) {
                    lines[closeIdx] = translatedLines.slice(closeIdx - i - 1).join("\n");
                }
                i = closeIdx + 1;
                continue;
            }
        }
        const isCodeModeLang = lang === "" || lang === "ts" || lang === "tsx" || lang === "js" || lang === "jsx" || lang === "typescript" || lang === "javascript" || lang === "plurnk";
        const hasNestedFence = /^ {0,3}(?:`{3,}|~{3,})/mu.test(inner);
        if (isCodeModeLang && !hasNestedFence && /(?:^|[;\s])(?:(?:await\s+)?plurnk\s*(?:\.|\[|\()|await\s+[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\()/mu.test(inner)) {
            advisories.push({
                position: { line: i + 1, column: openMatch[1].length },
                message: "Code Mode statements need no Markdown fence; write `await plurnk.<op>(...)` directly.",
            });
            lines[i] = "";
            lines[closeIdx] = "";
            i = closeIdx + 1;
            continue;
        }
        i = closeIdx + 1;
    }
    return { source: lines.join("\n"), advisories };
};

export const translateToolCallsOutsideFences = (input: string, executorSpellings: ReadonlyMap<string, RuntimeTag>): string => {
    const { masked, bodies } = maskHeredocBodies(input);
    const strippedSeedThink = masked.replace(
        /<(?:seed|mm|minimax):think>[\s\S]*?<\/(?:seed|mm|minimax):think>|^[ \t]*[^\r\n]*?<\/(?:seed|mm|minimax):think>[ \t]*(?=(?:await\s+)?[A-Za-z_$(])/gimu,
        (fullMatch) => padNewlines("", fullMatch),
    );
    const preTranslated = strippedSeedThink.replace(
        /<[|｜]tool[▁_]calls(?:_section)?[▁_]begin[|｜]>[\s\S]*?<[|｜]tool[▁_]calls(?:_section)?[▁_]end[|｜]>|<[|｜]tool[▁_]call[▁_]begin[|｜]>[\s\S]*?<[|｜]tool[▁_]call[▁_]end[|｜]>|<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>|<((?:[|｜]+)?DSML[|｜]+\s*(?:function_calls?|tool_calls?|calls|invoke)|(?:antml:|[A-Za-z_$][A-Za-z0-9$]*[._:-])?(?:invoke|function|toolcall|toolcalls|tool_call|tool_calls|functioncall|functioncalls|function_call|function_calls|tool-call|tool-calls|tool calls?|function calls?|tool|call|calls|tool_use|tool use|result))\b[^>]*>[\s\S]*?<\/\1>/giu,
        (fullMatch) => translateSegmentToolCalls(fullMatch, executorSpellings),
    );
    const lines = preTranslated.split("\n");
    const out: string[] = [];
    let nonFenceStart = 0;
    let i = 0;
    while (i < lines.length) {
        const openMatch = /^( {0,3})(`{3,}|~{3,})([^\n`~]*)\r?$/u.exec(lines[i]);
        if (openMatch === null) {
            i += 1;
            continue;
        }
        const fence = openMatch[2];
        const fenceChar = fence[0];
        const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fence.length},}[ \\t]*\\r?$`, "u");
        let closeIdx = -1;
        for (let j = i + 1; j < lines.length; j += 1) {
            if (closeRe.test(lines[j])) {
                closeIdx = j;
                break;
            }
        }
        if (closeIdx === -1) break;
        if (nonFenceStart < i) {
            out.push(translateSegmentToolCalls(lines.slice(nonFenceStart, i).join("\n"), executorSpellings));
        }
        out.push(lines.slice(i, closeIdx + 1).join("\n"));
        i = closeIdx + 1;
        nonFenceStart = i;
    }
    if (nonFenceStart < lines.length) {
        out.push(translateSegmentToolCalls(lines.slice(nonFenceStart).join("\n"), executorSpellings));
    }
    return unmaskHeredocBodies(out.join("\n"), bodies);
};
