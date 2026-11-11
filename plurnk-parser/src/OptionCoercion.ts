import {
    PLURNK_OPS,
    PlurnkParseError,
    isExecutionOp,
    isRecord,
    type LineMarker,
    type MatcherBody,
    type PlurnkOp,
    type Position,
    type ResourceSelection,
    type RuntimeTag,
    type SendBody,
    type TextLineMarker,
} from "@plurnk/plurnk-contracts";
import { BUILTIN_STANDALONE_EXECUTORS } from "./CodeSerializer.ts";
import { hasHeredocKey, toStringValue, unwrapQuotedHeredoc } from "./HeredocSyntax.ts";
import { parseMatcher } from "./MatcherSyntax.ts";
import { parseLineMarker, parseRangeMarker, parseTextLineMarker } from "./ScopeSyntax.ts";
import { parsePath } from "./TargetSyntax.ts";

export interface CodeModeOptions {
    readonly executors?: readonly string[];
}

export interface ParsedCall {
    readonly chain: readonly string[];
    readonly args: readonly unknown[];
    readonly position: Position;
}

export const PLURNK_RUNTIME_TOOLS: ReadonlySet<string> = new Set([
    "environment",
    "env",
    "mcp",
    "members",
    "personas",
    "schedule",
    "skills",
    "question",
    "fx",
    "destroy",
]);

const JS_ALIAS_SPELLINGS: ReadonlySet<string> = new Set([
    "ts",
    "javascript",
    "typescript",
    "node",
]);

export const CORE_OP_MAP: ReadonlyMap<string, PlurnkOp> = new Map(
    PLURNK_OPS.map((op) => [op.toLowerCase(), op]),
);

export const buildExecutorSpellings = (executors?: readonly string[]): Map<string, RuntimeTag> => {
    const map = new Map<string, RuntimeTag>();
    for (const builtin of BUILTIN_STANDALONE_EXECUTORS) {
        if (isExecutionOp(builtin)) {
            map.set(builtin, builtin);
        }
    }
    map.set("plurnk", "plurnk");
    for (const name of executors ?? []) {
        const lower = name.toLowerCase();
        if (isExecutionOp(lower)) {
            map.set(lower, lower);
        }
    }
    if (map.has("js")) {
        for (const alias of JS_ALIAS_SPELLINGS) {
            if (!map.has(alias)) {
                map.set(alias, "js");
            }
        }
    }
    return map;
};

export const IGNORED_OPTION_KEYS: ReadonlySet<string> = new Set([
    "id",
    "call_id",
    "tool_call_id",
    "timeout",
    "server",
    "dependency_graph",
    "change",
    "effect",
    "extent",
]);

export const assertAllowedKeys = (
    obj: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    opLabel: string,
    recovery: string,
    pos: Position,
): void => {
    for (const wrapperKey of ["text", "params", "parameters", "arguments", "args", "input", "options", "properties"]) {
        if (!allowed.has(wrapperKey) && isRecord(obj[wrapperKey])) {
            const nested = obj[wrapperKey];
            delete obj[wrapperKey];
            for (const [nk, nv] of Object.entries(nested)) {
                if (!(nk in obj)) obj[nk] = nv;
            }
        }
    }
    if (
        allowed.has("pattern")
        && obj.pattern === undefined
        && obj.matcher === undefined
        && obj.query === undefined
        && typeof obj.range === "string"
        && /^(?:\$(?:\.|\[|\.\.)|\/|~|&)/u.test(obj.range.trim())
    ) {
        obj.pattern = obj.range;
        delete obj.range;
    }
    for (const [key, value] of Object.entries(obj)) {
        if (
            key === "text" &&
            !allowed.has("text") &&
            typeof value === "string" &&
            (value.trim() === "" || value.trim() === "{}")
        ) {
            delete obj.text;
            continue;
        }
        if (value !== undefined && !allowed.has(key) && !IGNORED_OPTION_KEYS.has(key)) {
            throw new PlurnkParseError(
                pos.line,
                pos.column,
                "visitor",
                `Unknown option \`${key}\` on \`${opLabel}\`.`,
                "error",
                recovery,
            );
        }
    }
};

export const READ_FIND_KEYS: ReadonlySet<string> = new Set([
    "path", "paths", "target", "targets", "uri", "resource", "resources", "file_path", "filePath", "filepath", "file",
    "range", "lines", "scope", "limit", "pattern", "matcher", "query",
    "headers", "note", "aside",
]);

export const EDIT_KEYS: ReadonlySet<string> = new Set([
    "path", "target", "uri", "resource", "file_path", "filePath", "filepath", "file",
    "range", "lines", "scope", "pattern", "matcher",
    "oldText", "old_string", "old_text",
    "newText", "new_string", "new_text", "replacement", "content", "body", "text",
    "edits", "headers", "aside",
]);

export const EDIT_ITEM_KEYS: ReadonlySet<string> = new Set([
    "range", "lines", "scope", "pattern", "matcher",
    "oldText", "old_string", "old_text",
    "newText", "new_string", "new_text", "replacement", "content", "body", "text",
]);

export const TRANSFER_KEYS: ReadonlySet<string> = new Set([
    "from", "source", "src", "to", "destination", "dest",
    "range", "lines", "scope", "sourceRange", "fromRange",
    "pattern", "matcher", "sourcePattern", "fromPattern",
    "headers", "sourceHeaders", "fromHeaders",
    "toRange", "destinationRange", "destRange",
    "toPattern", "destinationPattern",
    "toHeaders", "destinationHeaders",
    "aside",
]);

const SELECTION_KEYS: ReadonlySet<string> = new Set([
    "path", "target", "uri", "resource", "range", "lines", "scope", "pattern", "matcher", "query", "headers",
]);

export const KILL_KEYS: ReadonlySet<string> = new Set([
    "path", "paths", "target", "targets", "uri", "resource", "resources", "file_path", "filePath", "filepath", "file",
    "range", "lines", "scope", "pattern", "matcher",
    "note", "distillation", "body", "content", "text",
    "remote", "headers", "aside",
]);

export const NOTE_KEYS: ReadonlySet<string> = new Set([
    "text", "content", "body", "note", "message",
    "title", "fact", "facts", "decision", "decisions", "hypothesis", "hypotheses", "observation", "observations", "finding", "findings", "summary",
    "path", "target", "uri", "resource", "range", "lines", "scope", "aside",
]);

export const TODO_KEYS: ReadonlySet<string> = new Set([
    "items", "todos", "text", "content", "body", "note", "aside",
]);

export const DELEGATION_KEYS: ReadonlySet<string> = new Set([
    "target", "path", "uri", "resource", "session", "prompt", "body", "content", "text", "message", "aside",
]);

export const SEND_KEYS: ReadonlySet<string> = new Set([
    "target", "to", "recipient", "path", "uri", "resource", "session",
    "headers", "attachments", "text", "content", "body", "message", "json", "aside",
]);

export const CONCLUSION_KEYS: ReadonlySet<string> = new Set([
    "target", "to", "recipient", "path", "uri", "resource", "attachments",
    "text", "content", "body", "message", "reason", "summary", "json", "aside",
]);

const CALLER_TARGET_ALIASES: ReadonlySet<string> = new Set([
    "user",
    "client",
    "human",
    "operator",
    "caller",
    "session://user",
    "session://client",
    "session://human",
    "session://operator",
    "session://caller",
]);

export const isCallerTargetAlias = (raw: string): boolean =>
    CALLER_TARGET_ALIASES.has(raw.trim().toLowerCase());

export const isConclusionCallerAlias = (raw: string): boolean =>
    isCallerTargetAlias(raw) || /^session:\/\/[^/]+\/?$/iu.test(raw.trim());

export const isBareScriptFilename = (runtime: string, value: unknown): value is string => {
    if (typeof value !== "string") return false;
    if (runtime === "js") {
        return /^(?:\.{0,2}\/)?[A-Za-z0-9_./-]+\.(?:m?js|cjs|m?ts|cts)$/u.test(value);
    }
    if (runtime === "python3") {
        return /^(?:\.{0,2}\/)?[A-Za-z0-9_./-]+\.py$/u.test(value);
    }
    return false;
};

export const WAIT_KEYS: ReadonlySet<string> = new Set([
    "target", "for", "path", "uri", "resource", "session", "seconds", "duration",
    "text", "body", "content", "message", "reason", "aside",
]);

export const BUILTIN_EXEC_KEYS: ReadonlySet<string> = new Set([
    "text", "code", "command", "cmd", "body", "source", "prompt",
    "cwd", "script", "target", "path", "file", "args",
    "range", "lines", "scope", "aside",
]);

export const CALL_OPTIONS_KEYS: ReadonlySet<string> = new Set([
    "range", "lines", "scope", "aside",
]);

export const toSendBody = (raw: string): SendBody => {
    let json: unknown = null;
    try { json = JSON.parse(raw); } catch { /* best-effort */ }
    return { raw, json };
};

export const toHeaders = (value: unknown, pos: Position): Record<string, string> | null => {
    if (value === undefined || value === null) return null;
    if (!isRecord(value)) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "`headers` must be an object mapping header names to string values.", "error",
            'Write `headers: { "Authorization": "Bearer ..." }`.');
    }
    const entries = Object.entries(value);
    if (entries.length === 0) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of entries) {
        if (typeof v !== "string") {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `Header \`${k}\` value must be a string.`, "error",
                'Write `headers: { "Authorization": "Bearer ..." }`.');
        }
        out[k] = v;
    }
    return out;
};

export const toAttachments = (value: unknown, pos: Position): string[] | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", "`attachments` cannot contain an empty address.", "error",
                'Write `attachments: ["path/to/file"]`.');
        }
        return [trimmed];
    }
    if (!Array.isArray(value)) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "`attachments` must be an array of non-empty resource address strings.", "error",
            'Write `attachments: ["path/to/file"]`.');
    }
    if (value.length === 0) return null;
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== "string" || item.trim().length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", "`attachments` must be an array of non-empty resource address strings.", "error",
                'Write `attachments: ["path/to/file"]`.');
        }
        out.push(item.trim());
    }
    return out;
};

export const toRemote = (value: unknown, pos: Position): boolean | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "boolean") {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "`remote` must be a boolean.", "error",
            'Write `remote: true`.');
    }
    return value;
};

const toRangeString = (value: unknown, pos: Position): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "" || /^\d+\s+resources?$/iu.test(trimmed)) return null;
        return value;
    }
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) {
        if (value.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", "range array cannot be empty", "error",
                'Write `range: "1,50"` or `range: [1, 50]`.');
        }
        return value.map((item) => toStringValue(item)).join(",");
    }
    if (isRecord(value)) {
        const start = value.start ?? value.from ?? value.line;
        const end = value.end ?? value.to ?? value.endLine;
        if (start !== undefined && end !== undefined) return `${toStringValue(start)},${toStringValue(end)}`;
        if (start !== undefined) return toStringValue(start);
    }
    throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid range ${JSON.stringify(value)}`, "error",
        'Write `range: "1,50"` or `range: "@start,@end"`.');
};

export const toLineMarker = (value: unknown, pos: Position, rangeMode = false): LineMarker | null => {
    const raw = toRangeString(value, pos);
    if (raw === null) return null;
    return rangeMode ? parseRangeMarker(raw, pos) : parseLineMarker(raw, pos);
};

export const toTextLineMarker = (value: unknown, pos: Position): TextLineMarker | null => {
    const raw = toRangeString(value, pos);
    if (raw === null) return null;
    return parseTextLineMarker(raw, pos);
};

const escapeRegexLiteral = (literal: string): string =>
    literal.replaceAll(/[.*+?^${}()|[\]\\/]/gu, "\\$&").replaceAll("\r", "\\r").replaceAll("\n", "\\n");

export const oldTextToMatcher = (oldText: string, pos: Position): MatcherBody => {
    if (oldText.length === 0) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "oldText cannot be empty", "error",
            'Provide non-empty `oldText` to match, or use `range` / `text` for line-scoped or whole-file edits.');
    }
    const isMultilineSlashRegexLike = /[\r\n]/u.test(oldText)
        && oldText.startsWith("/")
        && !oldText.startsWith("//")
        && /(?<!\\)\/[dgimsuvy]*$/u.test(oldText);
    if ((/[\r\n]/u.test(oldText) && !isMultilineSlashRegexLike) || !/^(?:\/|\$|~|&|\^)/u.test(oldText)) {
        return { dialect: "glob", raw: oldText };
    }
    const pattern = escapeRegexLiteral(oldText);
    return { dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" };
};

export const toMatcherBody = (value: unknown, op: string, pos: Position, isHeredoc = false): MatcherBody | null => {
    if (value === undefined || value === null) return null;
    if (value instanceof RegExp) {
        return {
            dialect: "regex",
            raw: `/${value.source}/${value.flags}`,
            pattern: value.source,
            flags: value.flags,
        };
    }
    if (typeof value === "string") {
        if (value.length === 0) return null;
        const unwrappedHeredoc = unwrapQuotedHeredoc(value);
        const effectiveHeredoc = isHeredoc || unwrappedHeredoc !== null;
        const raw = effectiveHeredoc
            ? (unwrappedHeredoc ?? value).replace(/(?:\r\n|\r|\n)$/u, "")
            : value;
        if (raw.length === 0) return null;
        const parsed = parseMatcher(raw, op, pos);
        if (parsed.dialect === "xpath") {
            return parsed;
        }
        if (
            effectiveHeredoc
            && !/[\r\n]/u.test(raw)
            && raw.startsWith("/")
            && !raw.startsWith("//")
            && !/(?<!\\)\/[dgimsuvy]*$/u.test(raw)
        ) {
            return oldTextToMatcher(raw, pos);
        }
        if (
            parsed.dialect === "unreadable"
            && (
                effectiveHeredoc
                || (
                    op === "edit"
                    && (/^\/\/(?:\s|\/)/u.test(raw) || (raw.startsWith("$") && !/^\$(?:\.|\[|\.\.)/u.test(raw)) || /^&(?:&|\s)/u.test(raw))
                )
            )
        ) {
            return oldTextToMatcher(raw, pos);
        }
        return parsed;
    }
    if (isRecord(value) && typeof value.dialect === "string" && typeof value.raw === "string") {
        return parseMatcher(value.raw, op, pos);
    }
    throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid pattern ${JSON.stringify(value)}`, "error",
        'Write a pattern such as `<<<EOF\\n...\\nEOF`, `"/needle/i"`, `"$..items"`, or `"*.ts"`.');
};

export const parseSelectionInput = (
    input: unknown,
    op: "copy" | "move",
    role: "from" | "to",
    pos: Position,
): ResourceSelection => {
    if (typeof input === "string") {
        const target = parsePath(input, pos);
        if (target === null) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires a non-empty '${role}' target.`, "error",
                `plurnk.${op}({ from: "source", to: "destination" })`);
        }
        return { target, lineMarker: null, matcher: null, headers: null };
    }
    if (isRecord(input)) {
        assertAllowedKeys(input, SELECTION_KEYS, `plurnk.${op}.${role}`, `plurnk.${op}({ from: "source", to: "destination" })`, pos);
        const rawPath = input.path ?? input.target ?? input.uri ?? input.resource;
        if (typeof rawPath !== "string" || rawPath.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires a '${role}.path' target.`, "error",
                `plurnk.${op}({ from: "source", to: "destination" })`);
        }
        const target = parsePath(rawPath, pos);
        if (target === null) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires a non-empty '${role}' target.`, "error");
        }
        const lineMarker = toTextLineMarker(input.range ?? input.lines ?? input.scope, pos);
        const matcher = toMatcherBody(input.pattern ?? input.matcher ?? input.query, op, pos, hasHeredocKey(input, "pattern", "matcher", "query"));
        const headers = toHeaders(input.headers, pos);
        return { target, lineMarker, matcher, headers };
    }
    throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires both from and to targets.`, "error",
        `plurnk.${op}({ from: "source", to: "destination" })`);
};

export const attemptVerbOf = (code: string): string => {
    const plurnkMatch = /\bplurnk\s*(?:\.\s*([A-Za-z0-9_$-]+)|\[\s*["']([^"']+)["']\s*\])/u.exec(code);
    if (plurnkMatch !== null) {
        const raw = plurnkMatch[1] ?? plurnkMatch[2] ?? "plurnk";
        const core = CORE_OP_MAP.get(raw.toLowerCase());
        if (core !== undefined) return core;
        if (PLURNK_RUNTIME_TOOLS.has(raw.toLowerCase())) return "plurnk";
        return raw;
    }
    const serviceMatch = /(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$-]*)\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(/u.exec(code);
    if (serviceMatch !== null) {
        return serviceMatch[1];
    }
    return "plurnk";
};
