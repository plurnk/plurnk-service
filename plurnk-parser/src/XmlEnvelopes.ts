import {
    isExecutionOp,
    isRecord,
    type RuntimeTag,
} from "@plurnk/plurnk-contracts";
import { propAccess } from "./CodeSerializer.ts";
import {
    CORE_OP_MAP,
    PLURNK_RUNTIME_TOOLS,
} from "./OptionCoercion.ts";

const NATIVE_TOOL_EXECUTOR_FALLBACKS: Readonly<Record<string, RuntimeTag>> = {
    bash: "sh",
    shell: "sh",
    python: "python3",
    py: "python3",
};

const WRAPPER_VERBS: ReadonlySet<string> = new Set([
    "invoke",
    "call",
    "calls",
    "tool",
    "tools",
    "toolcall",
    "toolcalls",
    "tool_call",
    "tool_calls",
    "tool-call",
    "tool-calls",
    "tool call",
    "tool calls",
    "tool_use",
    "tool-use",
    "tool use",
    "tool_code",
    "function",
    "functions",
    "functioncall",
    "functioncalls",
    "function_call",
    "function_calls",
    "function-call",
    "function-calls",
    "function call",
    "function calls",
    "emission",
    "result",
    "unfenced",
]);

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

export const parseWrapperTag = (rawTag: string): { readonly isWrapper: boolean; readonly defaultService?: string } => {
    const trimmed = rawTag.trim();
    const lower = trimmed.toLowerCase();
    if (WRAPPER_VERBS.has(lower)) {
        return { isWrapper: true };
    }
    const dsmlMatch = /^(?:[|｜]+)?DSML[|｜]+\s*([A-Za-z0-9_-]+)$/iu.exec(trimmed);
    if (dsmlMatch !== null && WRAPPER_VERBS.has(dsmlMatch[1].toLowerCase())) {
        return { isWrapper: true };
    }
    const prefixMatch = /^([A-Za-z_$][A-Za-z0-9$]*)[._:-]([A-Za-z0-9_-]+)$/iu.exec(trimmed);
    if (prefixMatch !== null && WRAPPER_VERBS.has(prefixMatch[2].toLowerCase())) {
        const prefix = prefixMatch[1].toLowerCase();
        return {
            isWrapper: true,
            defaultService: prefix === "antml" || prefix === "dsml" ? undefined : prefix,
        };
    }
    return { isWrapper: false };
};

export const padNewlines = (replacement: string, original: string): string => {
    const origLines = (original.match(/\n/gu) ?? []).length;
    const replLines = (replacement.match(/\n/gu) ?? []).length;
    return origLines > replLines ? `${replacement}${"\n".repeat(origLines - replLines)}` : replacement;
};

export const resolveToolCallTarget = (
    rawName: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    strictService = false,
    defaultService?: string,
): string | null => {
    const trimmed = rawName.trim().replace(/^functions\./iu, "").replace(/:\d+$/u, "").trim();
    if (trimmed.length === 0) return null;
    if (parseWrapperTag(trimmed).isWrapper) return null;
    const resolveKnownPlurnkMember = (member: string): string | null => {
        const lower = member.toLowerCase();
        if (CORE_OP_MAP.has(lower) || PLURNK_RUNTIME_TOOLS.has(lower)) return lower;
        const runtime = executorSpellings.get(lower);
        if (runtime !== undefined) return runtime;
        const fallback = NATIVE_TOOL_EXECUTOR_FALLBACKS[lower];
        if (fallback !== undefined && executorSpellings.has(fallback)) return fallback;
        return null;
    };
    const canonicalPlurnkMember = (member: string): string =>
        resolveKnownPlurnkMember(member) ?? member;

    const dotIdx = trimmed.indexOf(".");
    if (dotIdx !== -1) {
        const service = trimmed.slice(0, dotIdx).trim();
        const tool = trimmed.slice(dotIdx + 1).trim();
        if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(service) || tool.length === 0) return null;
        if (WRAPPER_VERBS.has(tool.toLowerCase())) return null;
        const lowerService = service.toLowerCase();
        if (lowerService === "plurnk") {
            if (strictService && resolveKnownPlurnkMember(tool) === null) {
                return null;
            }
            return `await plurnk${propAccess(canonicalPlurnkMember(tool))}`;
        }
        if (strictService ? !executorSpellings.has(lowerService) : (!isExecutionOp(lowerService) && !executorSpellings.has(lowerService))) {
            return null;
        }
        return `await ${lowerService}${propAccess(tool)}`;
    }
    const mcpMatch = /^(?:mcp__)?([A-Za-z0-9_-]+)__(.+)$/iu.exec(trimmed);
    if (mcpMatch !== null) {
        const service = mcpMatch[1].toLowerCase();
        const tool = mcpMatch[2].trim();
        if (tool.length === 0 || WRAPPER_VERBS.has(tool.toLowerCase())) return null;
        if (service === "plurnk") {
            if (strictService && resolveKnownPlurnkMember(tool) === null) return null;
            return `await plurnk${propAccess(canonicalPlurnkMember(tool))}`;
        }
        if (strictService ? !executorSpellings.has(service) : (!isExecutionOp(service) && !executorSpellings.has(service))) {
            return null;
        }
        return `await ${service}${propAccess(tool)}`;
    }
    const directKnown = resolveKnownPlurnkMember(trimmed);
    if (directKnown !== null && (defaultService === undefined || defaultService === "plurnk")) {
        return `await plurnk${propAccess(directKnown)}`;
    }
    const prefixMatch = /^([A-Za-z_$][A-Za-z0-9$]*)[_:-](.+)$/iu.exec(trimmed);
    if (prefixMatch !== null) {
        const service = prefixMatch[1].toLowerCase();
        const tool = prefixMatch[2].trim();
        if (tool.length === 0 || WRAPPER_VERBS.has(tool.toLowerCase())) return null;
        if (service === "plurnk" || WRAPPER_VERBS.has(service)) {
            const known = resolveKnownPlurnkMember(tool);
            if (known === null) return null;
            return `await plurnk${propAccess(known)}`;
        }
        if (executorSpellings.has(service)) {
            return `await ${service}${propAccess(tool)}`;
        }
    }
    if (defaultService !== undefined && defaultService !== "plurnk") {
        const lowerDefault = defaultService.toLowerCase();
        if (executorSpellings.has(lowerDefault)) {
            return `await ${lowerDefault}${propAccess(trimmed)}`;
        }
    }
    if (directKnown !== null) {
        return `await plurnk${propAccess(directKnown)}`;
    }
    return null;
};

export const formatTranslatedCall = (target: string, rawArgs: unknown): string => {
    if (rawArgs === undefined || rawArgs === null) {
        return `${target}()`;
    }
    if (typeof rawArgs === "string") {
        const trimmed = rawArgs.trim();
        if (trimmed.length === 0) return `${target}()`;
        try {
            const parsed: unknown = JSON.parse(trimmed);
            return formatTranslatedCall(target, parsed);
        } catch {
            return `${target}(${JSON.stringify(rawArgs)})`;
        }
    }
    if (Array.isArray(rawArgs)) {
        return `${target}(${rawArgs.map((item) => JSON.stringify(item)).join(", ")})`;
    }
    return `${target}(${JSON.stringify(rawArgs)})`;
};

export const coerceToolParamValue = (rawVal: string): unknown => {
    const trimmedVal = rawVal.trim();
    if (/^(?:\[[\s\S]*\]|\{[\s\S]*\}|true|false|null)$/u.test(trimmedVal)) {
        try {
            return JSON.parse(trimmedVal);
        } catch {
            // Keep literal string when not valid JSON.
        }
    }
    return rawVal;
};

export const unescapeXmlAttrValue = (raw: string, quote: '"' | "'" | null): string => {
    if (quote === '"') {
        try {
            const parsed: unknown = JSON.parse(`"${raw}"`);
            if (typeof parsed === "string") return parsed;
        } catch {
            // Fallback to basic unescaping below.
        }
    }
    return raw
        .replace(/\\(["'\\])/gu, "$1")
        .replace(/\\n/gu, "\n")
        .replace(/\\r/gu, "\r")
        .replace(/\\t/gu, "\t");
};

const parseXmlAttributes = (attrText: string): Record<string, unknown> => {
    const attrRe = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|“([^”]*)”|‘([^’]*)’|([^\s"'=<>`/]+))/gu;
    const attrs: Record<string, unknown> = {};
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrText)) !== null) {
        const key = m[1].trim();
        const lowerKey = key.toLowerCase();
        if (key.length === 0 || lowerKey === "xmlns" || lowerKey.startsWith("xmlns:")) continue;
        const rawVal = m[2] !== undefined
            ? unescapeXmlAttrValue(m[2], '"')
            : m[3] !== undefined
                ? unescapeXmlAttrValue(m[3], "'")
                : m[4] !== undefined
                    ? unescapeXmlAttrValue(m[4], '"')
                    : m[5] !== undefined
                        ? unescapeXmlAttrValue(m[5], "'")
                        : (m[6] ?? "");
        attrs[key] = coerceToolParamValue(rawVal);
    }
    const trailingPayloadMatch = /\b(text|content|newText|new_string|new_text|body|command)\s*=\s*"([\s\S]*)"\s*$/u.exec(attrText);
    if (trailingPayloadMatch !== null) {
        const key = trailingPayloadMatch[1];
        const rawPayload = trailingPayloadMatch[2];
        const existing = attrs[key];
        if (typeof existing !== "string" || existing.length < rawPayload.length) {
            attrs[key] = unescapeXmlAttrValue(rawPayload, null);
        }
    }
    return attrs;
};

export const parseXmlToolCallBody = (body: string): unknown => {
    const unwrappedBody = body
        .trim()
        .replace(/^<(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameters|params|arguments|args|input)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameters|params|arguments|args|input)>$/iu, "$1");

    // Z.AI GLM-4.5 / GLM-4.7 / GLM-5 `<arg_key>k</arg_key><arg_value>v</arg_value>` pairs
    const glmArgRe = /<arg_key\b[^>]*>([\s\S]*?)<\/arg_key>\s*<arg_value\b[^>]*>([\s\S]*?)<\/arg_value>/giu;
    const glmParams: Record<string, unknown> = {};
    let matchedGlm = false;
    let m: RegExpExecArray | null;
    while ((m = glmArgRe.exec(unwrappedBody)) !== null) {
        matchedGlm = true;
        const key = m[1].trim();
        if (key.length === 0) continue;
        const rawVal = (m[2] ?? "")
            .replace(/^\r?\n/u, "")
            .replace(/\r?\n$/u, "");
        glmParams[key] = coerceToolParamValue(rawVal);
    }
    if (matchedGlm) return glmParams;

    const paramRe = /<(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameter|param|arg|argument)\b(?:\s+name=[“”"'‘’]([^“”"'‘’]+)[“”"'‘’]|=([A-Za-z0-9_.-]+))[^>]*>([\s\S]*?)(?:<\/(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameter|param|arg|argument)>|(?=<(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameter|param|arg|argument)\b)|$)/giu;
    const params: Record<string, unknown> = {};
    let matchedParam = false;
    while ((m = paramRe.exec(unwrappedBody)) !== null) {
        matchedParam = true;
        const key = (m[1] ?? m[2] ?? "").trim();
        if (key.length === 0) continue;
        const rawVal = (m[3] ?? "")
            .replace(/^\r?\n/u, "")
            .replace(/\r?\n$/u, "")
            .replace(/^(?:true|false)["']>/iu, "");
        params[key] = coerceToolParamValue(rawVal);
    }
    if (matchedParam) return params;

    const directFieldRe = /<(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?([A-Za-z_][A-Za-z0-9_-]*)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?\1>/giu;
    const directParams: Record<string, unknown> = {};
    let matchedDirectField = false;
    while ((m = directFieldRe.exec(unwrappedBody)) !== null) {
        const rawKey = m[1].trim();
        if (!DIRECT_XML_PARAM_KEYS.has(rawKey.toLowerCase())) continue;
        matchedDirectField = true;
        const rawVal = (m[2] ?? "")
            .replace(/^\r?\n/u, "")
            .replace(/\r?\n$/u, "");
        directParams[rawKey] = coerceToolParamValue(rawVal);
    }
    if (matchedDirectField) return directParams;

    const cleaned = unwrappedBody
        .replace(/<\/?(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:parameter|param|arg|argument)\b[^>]*>/giu, "")
        .trim()
        .replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu, "$1")
        .trim();
    if (cleaned.length === 0) return {};
    if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
        try {
            return JSON.parse(cleaned);
        } catch {
            return cleaned;
        }
    }
    return cleaned;
};

export const tryTranslateChildTagCall = (
    inner: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
    isResultWrapper = false,
): string | null => {
    // Z.AI GLM-4.5 / GLM-4.7 / GLM-5 `<tool_call>func_name\n<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`
    const glmHeadMatch = /^\s*([A-Za-z0-9_.:-]+)\s*(?=<arg_key\b)/iu.exec(inner);
    if (glmHeadMatch !== null) {
        const target = resolveToolCallTarget(glmHeadMatch[1], executorSpellings, false, defaultService);
        if (target !== null) {
            const remainder = inner.slice(glmHeadMatch[0].length);
            return formatTranslatedCall(target, parseXmlToolCallBody(remainder));
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
    const target = resolveToolCallTarget(rawName, executorSpellings, false, effectiveDefaultService);
    if (target === null) return null;
    const argsMatch = /<(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:arguments|args|parameters|params|input)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_$][A-Za-z0-9_$]*[._:-])?(?:arguments|args|parameters|params|input)>/iu.exec(inner);
    const remainder = argsMatch !== null
        ? argsMatch[1]
        : inner.replace(nameMatch[0], "").trim();
    const parsedArgs = remainder.length === 0 ? undefined : parseXmlToolCallBody(remainder);
    return formatTranslatedCall(target, parsedArgs);
};

export const replaceXmlInvocations = (
    text: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
): { readonly text: string; readonly translated: boolean } => {
    let translated = false;
    // 1. Malformed inline-call invoke tag, e.g. <｜｜DSML｜｜ invoke name="plurnk.find({...})</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke> or self-closing <｜｜DSML｜｜ invoke name="plurnk.note({...}) />
    let out = text.replace(
        /<(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9$]*[._:-])?(invoke|function|toolcall|tool_call|function_call|tool-call|tool|call|tool_use|tool-use|result)\b[^\r\n>]*?\bname=[“”"'‘’]((?:await\s+)?[A-Za-z_$][A-Za-z0-9_$.:-]*)\s*\(([\s\S]*?)\)\s*;?\s*[“”"'‘’]?([ \t]*\/\/[^\r\n<]*)?[“”"'‘’]?(?:\s*\/>|(?:\s*>|\s*<\/(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9$]*[._:-])?(?:parameter|param|arg|argument)>)(?:(?!<(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9$]*[._:-])?\1\b)[\s\S])*?<\/(?:antml:|(?:[|｜]+)?DSML[|｜]+\s*|[A-Za-z_$][A-Za-z0-9$]*[._:-])?\1>)/giu,
        (fullMatch, _verb: string, rawName: string, rawArgs: string, rawComment: string | undefined) => {
            const target = resolveToolCallTarget(rawName.replace(/^await\s+/iu, ""), executorSpellings, false, defaultService);
            if (target === null) return fullMatch;
            translated = true;
            const args = rawArgs.trim();
            const commentSuffix = rawComment === undefined ? "" : rawComment.replace(/[“”"'‘’]+$/u, "");
            return padNewlines(args.length === 0 ? `${target}();${commentSuffix}` : `${target}(${args});${commentSuffix}`, fullMatch);
        },
    );

    // 2. Standard <function=name>...</function> and paired/self-closing <([service._:-]|antml:|DSML)?(invoke|function|tool_call|function_call|tool|call|tool_use|result) (name|call|tool|op)="...">
    out = out.replace(
        /<function=([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/function>|<(?:([A-Za-z_$][A-Za-z0-9$]*)[._:-]|antml:|(?:[|｜]+)?DSML[|｜]+\s*)?(invoke|function|toolcall|tool_call|function_call|tool-call|tool|call|tool_use|tool-use|result)\b([^>]*?\b(?:name|call|tool|op)\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|“[^”]*”|‘[^’]*’|[^\s"'=<>`/]+)(?:[^/>]|\/(?!>))*)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_$][A-Za-z0-9$]*[._:-]|antml:|(?:[|｜]+)?DSML[|｜]+\s*)?\4>)/giu,
        (
            fullMatch,
            fnName: string | undefined,
            fnBody: string | undefined,
            tagPrefix: string | undefined,
            _verb: string | undefined,
            attrText: string | undefined,
            invBody: string | undefined,
        ) => {
            if (fnName !== undefined) {
                const target = resolveToolCallTarget(fnName.trim(), executorSpellings, false, defaultService);
                if (target === null) return fullMatch;
                translated = true;
                return padNewlines(formatTranslatedCall(target, parseXmlToolCallBody(fnBody ?? "")), fullMatch);
            }
            const attrs = parseXmlAttributes(attrText ?? "");
            const nameKey = (["name", "call", "tool", "op"] as const).find((k) => typeof attrs[k] === "string");
            const rawName = nameKey !== undefined && typeof attrs[nameKey] === "string" ? attrs[nameKey] : "";
            if (nameKey !== undefined) delete attrs[nameKey];
            const prefixLower = tagPrefix?.toLowerCase();
            const effectiveDefault = prefixLower !== undefined && prefixLower !== "antml" && prefixLower !== "dsml"
                ? prefixLower
                : defaultService;
            const target = resolveToolCallTarget(rawName, executorSpellings, false, effectiveDefault);
            if (target === null) return fullMatch;
            let args: unknown = Object.keys(attrs).length > 0 ? attrs : undefined;
            if (invBody !== undefined && invBody.trim().length > 0) {
                const parsedBody = parseXmlToolCallBody(invBody);
                if (args === undefined) {
                    args = parsedBody;
                } else if (isRecord(parsedBody)) {
                    args = { ...attrs, ...parsedBody };
                } else if (typeof parsedBody === "string" && attrs.content === undefined && attrs.text === undefined) {
                    args = { ...attrs, content: parsedBody };
                }
            }
            translated = true;
            return padNewlines(formatTranslatedCall(target, args), fullMatch);
        },
    );

    // 3. DeepSeek / Kimi token-delimited tool calls (<｜tool▁call▁begin｜>...<｜tool▁call▁end｜> and <|tool_call_begin|>...<|tool_call_end|>)
    out = out.replace(
        /<[|｜]tool[▁_]call[▁_]begin[|｜]>\s*(?:[A-Za-z0-9_.-]+\s*<[|｜]tool[▁_]sep[|｜]>\s*)?([^\r\n<|｜]+?)\s*(?:<[|｜]tool[▁_]call[▁_]argument[▁_]begin[|｜]>|\r?\n)([\s\S]*?)<[|｜]tool[▁_]call[▁_]end[|｜]>/giu,
        (fullMatch, rawName: string, rawBody: string) => {
            const target = resolveToolCallTarget(rawName, executorSpellings, false, defaultService);
            if (target === null) return fullMatch;
            translated = true;
            return padNewlines(formatTranslatedCall(target, parseXmlToolCallBody(rawBody)), fullMatch);
        },
    );

    // 4. Direct XML element tool calls (<plurnk.find path="..." />, <plurnk:read .../>, <plurnk_edit>...</plurnk_edit>, <await plurnk.read>...</await>, <gitea_issue_read .../>)
    out = out.replace(
        /<(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$-]*[._:-][A-Za-z_$][A-Za-z0-9_$-]*|mcp__[A-Za-z0-9_$-]+)((?:\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|“[^”]*”|‘[^’]*’|[^\s"'=<>`/]+))*)\s*(?:\/>(?:\s*<\/(?:await|\1)>)?|>([\s\S]*?)<\/(?:await|\1)>)/giu,
        (fullMatch, tagName: string, attrText: string | undefined, innerBody: string | undefined) => {
            const target = resolveToolCallTarget(tagName, executorSpellings, true, defaultService);
            if (target === null) return fullMatch;
            const attrs = parseXmlAttributes(attrText ?? "");
            let args: unknown = Object.keys(attrs).length > 0 ? attrs : undefined;
            if (innerBody !== undefined && innerBody.trim().length > 0) {
                const parsedBody = parseXmlToolCallBody(innerBody);
                if (args === undefined) {
                    args = parsedBody;
                } else if (isRecord(parsedBody)) {
                    args = { ...attrs, ...parsedBody };
                } else if (typeof parsedBody === "string" && attrs.content === undefined && attrs.text === undefined) {
                    args = { ...attrs, content: parsedBody };
                }
            }
            translated = true;
            return padNewlines(formatTranslatedCall(target, args), fullMatch);
        },
    );

    // 4b. Self-closing <plurnk.<op> ... /> with multiline or unescaped-quote payload attributes, plus bare no-arg <plurnk.<op>> on its own line
    out = out.replace(
        /<(?:await\s+)?(plurnk[._:-][A-Za-z_$][A-Za-z0-9_$-]*|[A-Za-z_$][A-Za-z0-9_$-]*_[A-Za-z_$][A-Za-z0-9_$-]*)(\s+[A-Za-z_][\s\S]*?)\/>(?:\s*<\/\1>)?/giu,
        (fullMatch, tagName: string, attrText: string) => {
            const target = resolveToolCallTarget(tagName, executorSpellings, true, defaultService);
            if (target === null) return fullMatch;
            const attrs = parseXmlAttributes(attrText);
            if (Object.keys(attrs).length === 0) return fullMatch;
            translated = true;
            return padNewlines(formatTranslatedCall(target, attrs), fullMatch);
        },
    );
    out = out.replace(
        /^[ \t]*<(?:await\s+)?(plurnk[._:-][A-Za-z_$][A-Za-z0-9_$-]*)\s*\/?>[ \t]*$/gimu,
        (fullMatch, tagName: string) => {
            const target = resolveToolCallTarget(tagName, executorSpellings, true, defaultService);
            if (target === null) return fullMatch;
            translated = true;
            return `${target}();`;
        },
    );

    // 5. <unfenced_code_edit_*> tag triplets
    out = out.replace(
        /<unfenced_code_edit_path>([\s\S]*?)<\/unfenced_code_edit_path>\s*(?:<unfenced_code_edit_range>([\s\S]*?)<\/unfenced_code_edit_range>\s*)?(?:<unfenced_code_edit_pattern>([\s\S]*?)<\/unfenced_code_edit_pattern>\s*)?<unfenced_code_edit_content>([\s\S]*?)<\/unfenced_code_edit_content>/giu,
        (fullMatch, rawPath: string, rawRange: string | undefined, rawPattern: string | undefined, rawContent: string) => {
            const editArgs: Record<string, unknown> = { path: rawPath.trim() };
            if (rawRange !== undefined && rawRange.trim().length > 0) editArgs.range = rawRange.trim();
            if (rawPattern !== undefined && rawPattern.trim().length > 0) editArgs.pattern = rawPattern.trim();
            editArgs.content = rawContent.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
            translated = true;
            return padNewlines(formatTranslatedCall("await plurnk.edit", editArgs), fullMatch);
        },
    );

    // 6. Angle-bracketed Code Mode hybrid calls (<await plurnk.edit({...})/>, <await plurnk.sh({...});, <plurnk.note({...}/>)}, <await plurnk.edit({...}); // fix</await>)
    out = out.replace(
        /^[ \t]*<(?:[A-Za-z_$][A-Za-z0-9_$-]*:)?(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$-]*\.[A-Za-z_$][A-Za-z0-9_$-]*)\s*\(\s*(\{[\s\S]*?\})\s*\)?\s*;?\s*\/?>(?:<\/(?:await|[A-Za-z_$][A-Za-z0-9_$.:-]*)>)?[ \t]*$/gmu,
        (fullMatch, rawTarget: string, jsonObj: string) => {
            const target = resolveToolCallTarget(rawTarget, executorSpellings, true);
            if (target === null) return fullMatch;
            translated = true;
            return padNewlines(`${target}(${jsonObj});`, fullMatch);
        },
    );
    out = out.replace(
        /^([ \t]*)<(?:[A-Za-z_$][A-Za-z0-9_$-]*:)?(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$-]*\.[A-Za-z_$][A-Za-z0-9_$-]*)\s*\(/gmu,
        (fullMatch, indent: string, rawTarget: string) => {
            const target = resolveToolCallTarget(rawTarget, executorSpellings, true);
            if (target === null) return fullMatch;
            translated = true;
            return `${indent}${target}(`;
        },
    );
    if (translated) {
        out = out
            .replace(/(\})\s*\/?>\s*(\)\s*\}?\s*;?[ \t]*(?:\/\/[^\r\n]*)?)$/gmu, "$1$2")
            .replace(/(\)\s*;?)[ \t]*\/?>(?:<\/(?:await|[A-Za-z_$][A-Za-z0-9_$.:-]*)>)?([ \t]*(?:\/\/[^\r\n]*)?)$/gmu, "$1$2")
            .replace(/<\/(?:await|plurnk(?:[._:-][A-Za-z_$][A-Za-z0-9_$-]*)?)>[ \t]*$/gimu, "");
    }

    return { text: out, translated };
};

export const translateXmlToolCalls = (
    text: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
): string | null => {
    const { text: replaced, translated } = replaceXmlInvocations(text, executorSpellings, defaultService);
    return translated ? replaced.trim() : null;
};
