import {
    isExecutionOp,
    isRecord,
    type Position,
    type RuntimeTag,
} from "@plurnk/plurnk-contracts";
import { parsePythonicCalls, parseValuePrefix } from "./CallExpressionParser.ts";
import { BUILTIN_STANDALONE_EXECUTORS } from "./CodeSerializer.ts";
import { findHeredocCloser, markHeredocIndices, matchHeredocOpener } from "./HeredocSyntax.ts";
import {
    CORE_OP_MAP,
    EDIT_KEYS,
    IGNORED_OPTION_KEYS,
    NOTE_KEYS,
    PLURNK_RUNTIME_TOOLS,
    type ParsedCall,
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

export const parseWrapperTag = (rawTag: string): { readonly isWrapper: boolean; readonly defaultService?: string } => {
    const trimmed = rawTag.trim().replace(/\s+/gu, " ");
    const lower = trimmed.toLowerCase();
    if (WRAPPER_VERBS.has(lower)) {
        return { isWrapper: true };
    }
    const dsmlMatch = /^(?:[|｜]+)?DSML[|｜]+\s*([A-Za-z0-9_ -]+)$/iu.exec(trimmed);
    if (dsmlMatch !== null && WRAPPER_VERBS.has(dsmlMatch[1].trim().toLowerCase())) {
        return { isWrapper: true };
    }
    const prefixMatch = /^([A-Za-z_$][A-Za-z0-9$]*)[._:-]([A-Za-z0-9_ -]+)$/iu.exec(trimmed);
    if (prefixMatch !== null && WRAPPER_VERBS.has(prefixMatch[2].trim().toLowerCase())) {
        const prefix = prefixMatch[1].toLowerCase();
        return {
            isWrapper: true,
            defaultService: prefix === "antml" || prefix === "dsml" ? undefined : prefix,
        };
    }
    return { isWrapper: false };
};

export const resolveCallChain = (
    rawName: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    strictService = false,
    defaultService?: string,
): readonly [string, string] | null => {
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
        if (lowerService === "multi_tool_use") return null;
        if (lowerService === "plurnk") {
            const known = resolveKnownPlurnkMember(tool);
            if (known !== null) return ["plurnk", known];
            const subDot = tool.indexOf(".");
            if (subDot !== -1) {
                const subService = tool.slice(0, subDot).trim();
                const subTool = tool.slice(subDot + 1).trim();
                if (
                    /^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(subService)
                    && subTool.length > 0
                    && !WRAPPER_VERBS.has(subTool.toLowerCase())
                ) {
                    const lowerSub = subService.toLowerCase();
                    if (strictService ? executorSpellings.has(lowerSub) : (isExecutionOp(lowerSub) || executorSpellings.has(lowerSub))) {
                        return [lowerSub, subTool];
                    }
                }
            }
            if (strictService) return null;
            return ["plurnk", tool];
        }
        if (strictService ? !executorSpellings.has(lowerService) : (!isExecutionOp(lowerService) && !executorSpellings.has(lowerService))) {
            return null;
        }
        return [lowerService, tool];
    }

    const mcpMatch = /^(?:mcp__)?([A-Za-z0-9_-]+)__(.+)$/iu.exec(trimmed);
    if (mcpMatch !== null) {
        const service = mcpMatch[1].toLowerCase();
        const tool = mcpMatch[2].trim();
        if (tool.length === 0 || WRAPPER_VERBS.has(tool.toLowerCase())) return null;
        if (service === "plurnk") {
            if (strictService && resolveKnownPlurnkMember(tool) === null) return null;
            return ["plurnk", canonicalPlurnkMember(tool)];
        }
        if (strictService ? !executorSpellings.has(service) : (!isExecutionOp(service) && !executorSpellings.has(service))) {
            return null;
        }
        return [service, tool];
    }

    const directKnown = resolveKnownPlurnkMember(trimmed);
    if (directKnown !== null && (defaultService === undefined || defaultService === "plurnk")) {
        return ["plurnk", directKnown];
    }

    const prefixMatch = /^([A-Za-z_$][A-Za-z0-9$]*)[_:-](.+)$/iu.exec(trimmed);
    if (prefixMatch !== null) {
        const service = prefixMatch[1].toLowerCase();
        const tool = prefixMatch[2].trim();
        if (tool.length === 0 || WRAPPER_VERBS.has(tool.toLowerCase())) return null;
        if (service === "plurnk" || WRAPPER_VERBS.has(service)) {
            const known = resolveKnownPlurnkMember(tool);
            if (known === null) return null;
            return ["plurnk", known];
        }
        if (executorSpellings.has(service)) {
            return [service, tool];
        }
    }

    if (defaultService !== undefined && defaultService !== "plurnk") {
        const lowerDefault = defaultService.toLowerCase();
        if (executorSpellings.has(lowerDefault)) {
            return [lowerDefault, trimmed];
        }
    }
    if (directKnown !== null) {
        return ["plurnk", directKnown];
    }
    return null;
};

export const normalizeDecodedArgs = (rawArgs: unknown, isTopHeredoc = false): readonly unknown[] => {
    if (rawArgs === undefined || rawArgs === null) {
        return [];
    }
    if (isTopHeredoc) {
        const out = [rawArgs];
        markHeredocIndices(out, [0]);
        return out;
    }
    if (typeof rawArgs === "string") {
        const trimmed = rawArgs.trim();
        if (trimmed.length === 0) return [];
        try {
            const parsed: unknown = JSON.parse(trimmed);
            return normalizeDecodedArgs(parsed);
        } catch {
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                const candidate = trimmed.replace(/([}\]])[ \t]*\)+[ \t]*;?$/u, "$1");
                const valueParsed = parseValuePrefix(candidate, 0);
                if (valueParsed !== null && candidate.slice(valueParsed.endOffset).trim() === "") {
                    return Array.isArray(valueParsed.value) ? valueParsed.value : [valueParsed.value];
                }
            }
            return [rawArgs];
        }
    }
    if (Array.isArray(rawArgs)) {
        return rawArgs;
    }
    return [rawArgs];
};

export const unescapeAttrValue = (raw: string, quote: '"' | "'" | null): string => {
    if (quote === '"') {
        try {
            const parsed: unknown = JSON.parse(`"${raw}"`);
            if (typeof parsed === "string") return parsed;
        } catch {
            // Fallback to basic escape decoding when raw contains unescaped inner quotes or non-JSON escapes.
        }
    }
    return raw
        .replace(/\\(["'\\])/gu, "$1")
        .replace(/\\n/gu, "\n")
        .replace(/\\r/gu, "\r")
        .replace(/\\t/gu, "\t");
};

export const coerceParamValue = (rawVal: string): { readonly value: unknown; readonly isHeredoc: boolean } => {
    const trimmedVal = rawVal.trim();
    if (/^(?:\[[\s\S]*\]|\{[\s\S]*\}|true|false|null)$/u.test(trimmedVal)) {
        try {
            return { value: JSON.parse(trimmedVal), isHeredoc: false };
        } catch {
            const valueParsed = (trimmedVal.startsWith("{") || trimmedVal.startsWith("["))
                ? parseValuePrefix(trimmedVal, 0)
                : null;
            if (valueParsed !== null && trimmedVal.slice(valueParsed.endOffset).trim() === "") {
                return { value: valueParsed.value, isHeredoc: false };
            }
        }
    }
    const opener = matchHeredocOpener(rawVal, 0, { allowXmlAttr: true, allowQuotedWrapper: true });
    if (opener !== null && opener.isInline) {
        const closer = findHeredocCloser(rawVal, opener.bodyStart, opener.tag, "inline", {
            outerQuote: opener.outerQuote ?? null,
            allowMalformedRecovery: false,
        });
        if (closer !== null && rawVal.slice(closer.afterTagOffset).trim() === "") {
            return { value: closer.body, isHeredoc: true };
        }
        if (opener.outerQuote === null) {
            return {
                value: rawVal.slice(opener.bodyStart).replaceAll("\r\n", "\n"),
                isHeredoc: true,
            };
        }
    }
    return { value: rawVal, isHeredoc: false };
};

const extractDescriptorCalls = (
    val: unknown,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    position: Position,
    defaultService?: string,
): readonly ParsedCall[] | null => {
    if (Array.isArray(val)) {
        if (val.length === 0) return null;
        const all: ParsedCall[] = [];
        for (const item of val) {
            const sub = extractDescriptorCalls(item, executorSpellings, position, defaultService);
            if (sub === null) return null;
            all.push(...sub);
        }
        return all;
    }
    if (!isRecord(val)) return null;

    if (isRecord(val.function) && typeof val.function.name === "string") {
        const chain = resolveCallChain(val.function.name, executorSpellings, false, defaultService);
        if (chain === null) return null;
        const rawArgs = val.function.arguments ?? val.function.parameters ?? val.function.input ?? val.function.args ?? {};
        return [{ chain, args: normalizeDecodedArgs(rawArgs), position }];
    }

    if (Array.isArray(val.tool_uses)) {
        return extractDescriptorCalls(val.tool_uses, executorSpellings, position, defaultService);
    }

    const explicitArgs = val.arguments ?? val.parameters ?? val.input ?? val.args;
    const rawName = val.recipient_name ?? val.name ?? val.tool ?? val.tool_name ?? (explicitArgs !== undefined ? val.command : undefined);
    if (typeof rawName === "string") {
        const chain = resolveCallChain(rawName, executorSpellings, false, defaultService);
        if (chain === null) return null;
        if (explicitArgs !== undefined) {
            return [{ chain, args: normalizeDecodedArgs(explicitArgs), position }];
        }
        const restArgs: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
            if (k !== "recipient_name" && k !== "name" && k !== "tool" && k !== "tool_name" && k !== "type" && k !== "index" && !IGNORED_OPTION_KEYS.has(k)) {
                restArgs[k] = v;
            }
        }
        return [{
            chain,
            args: [Object.keys(restArgs).length > 0 ? restArgs : {}],
            position,
        }];
    }

    const keys = Object.keys(val).filter((k) => !IGNORED_OPTION_KEYS.has(k));
    const hasPathKey = keys.some((k) => k === "path" || k === "target" || k === "uri" || k === "file_path" || k === "filepath" || k === "file");
    const hasEditPayloadKey = keys.some((k) => k === "text" || k === "content" || k === "body" || k === "newText" || k === "new_string" || k === "new_text" || k === "replacement" || k === "edits");
    if (hasPathKey && hasEditPayloadKey && keys.every((k) => EDIT_KEYS.has(k))) {
        return [{ chain: ["plurnk", "edit"], args: [val], position }];
    }
    if (
        !hasPathKey
        && (
            typeof val.text === "string"
            || typeof val.note === "string"
            || typeof val.discovery === "string"
            || typeof val.discoveries === "string"
            || typeof val.derivation === "string"
            || typeof val.derivations === "string"
            || typeof val.fact === "string"
            || typeof val.idea === "string"
            || typeof val.plan === "string"
            || typeof val.decision === "string"
            || typeof val.decisions === "string"
            || typeof val.hypothesis === "string"
        )
        && keys.every((k) => NOTE_KEYS.has(k))
    ) {
        return [{ chain: ["plurnk", "note"], args: [val], position }];
    }
    return null;
};

export const extractProxyCalls = (
    parsedBody: unknown,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    position: Position,
    defaultService?: string,
): readonly ParsedCall[] | null => {
    if (!isRecord(parsedBody)) return null;
    if (Array.isArray(parsedBody.tool_uses) && parsedBody.tool_uses.length > 0) {
        const subCalls: ParsedCall[] = [];
        for (const entry of parsedBody.tool_uses) {
            const sub = extractProxyCalls(entry, executorSpellings, position, defaultService);
            if (sub === null) return null;
            subCalls.push(...sub);
        }
        return subCalls;
    }
    const rawRecipient = parsedBody.recipient_name ?? parsedBody.tool_name ?? parsedBody.name ?? parsedBody.tool;
    if (typeof rawRecipient !== "string" || rawRecipient.trim().length === 0) return null;
    const chain = resolveCallChain(rawRecipient, executorSpellings, false, defaultService);
    if (chain === null) return null;
    const explicitParams = parsedBody.parameters ?? parsedBody.arguments ?? parsedBody.args ?? parsedBody.params ?? parsedBody.input;
    if (explicitParams !== undefined) {
        return [{ chain, args: normalizeDecodedArgs(explicitParams), position }];
    }
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsedBody)) {
        if (k !== "recipient_name" && k !== "tool_name" && k !== "name" && k !== "tool" && k !== "index" && k !== "id") {
            rest[k] = v;
        }
    }
    return [{ chain, args: Object.keys(rest).length > 0 ? [rest] : [], position }];
};

export const decodeJsonOrValueCalls = (
    rawText: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    position: Position,
    defaultService?: string,
): readonly ParsedCall[] | null => {
    const trimmed = rawText.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    const calls: ParsedCall[] = [];
    let cursor = 0;
    while (cursor < trimmed.length) {
        while (cursor < trimmed.length && /\s/u.test(trimmed[cursor])) cursor += 1;
        if (cursor >= trimmed.length) break;
        const parsed = parseValuePrefix(trimmed, cursor);
        if (parsed === null) return null;
        const itemCalls = extractDescriptorCalls(parsed.value, executorSpellings, position, defaultService);
        if (itemCalls === null || itemCalls.length === 0) return null;
        calls.push(...itemCalls);
        cursor = parsed.endOffset;
        while (cursor < trimmed.length && (trimmed[cursor] === " " || trimmed[cursor] === "\t" || trimmed[cursor] === ")" || trimmed[cursor] === ";" || trimmed[cursor] === ",")) {
            cursor += 1;
        }
    }
    return calls.length > 0 ? calls : null;
};

export const decodePythonicCalls = (
    rawText: string,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    position: Position,
    defaultService?: string,
    allowTrailing = false,
): { readonly calls: readonly ParsedCall[]; readonly endOffset: number } | null => {
    const parsed = parsePythonicCalls(rawText, position, allowTrailing);
    if (parsed === null) return null;
    const resolved: ParsedCall[] = [];
    for (const call of parsed.calls) {
        const joinedName = call.chain.length === 1 ? call.chain[0] : `${call.chain[0]}.${call.chain.slice(1).join(".")}`;
        const chain = resolveCallChain(joinedName, executorSpellings, false, defaultService);
        if (chain === null) return null;
        resolved.push({ ...call, chain });
    }
    return { calls: resolved, endOffset: parsed.endOffset };
};

export const hasFencedCodeModeCall = (
    inner: string,
    knownExecutors?: ReadonlyMap<string, RuntimeTag>,
): boolean => {
    if (/(?:^|[;\s<])(?:(?:await\s+)?plurnk\s*(?:\.|\[|\()|await\s+[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\()/mu.test(inner)) {
        return true;
    }
    if (knownExecutors === undefined) return false;
    for (const m of inner.matchAll(/(?:^|[;\s<])([A-Za-z_$][A-Za-z0-9_$-]*)\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(/gmu)) {
        const mapped = knownExecutors.get(m[1].toLowerCase());
        if (mapped !== undefined && !BUILTIN_STANDALONE_EXECUTORS.has(mapped)) {
            return true;
        }
    }
    return false;
};
