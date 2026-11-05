import {
    INTERNAL_ROW_OPS,
    PLURNK_OPS,
    PlurnkParseError,
    isExecution,
    isExecutionOp,
    isPlurnkOp,
    isRecord,
    type BareStatement,
    type CopyStatement,
    type DispositionStatement,
    type DoneStatement,
    type EditStatement,
    type ExecStatement,
    type FailStatement,
    type ForkStatement,
    type KillStatement,
    type LineMarker,
    type MatcherBody,
    type MoveStatement,
    type NoteStatement,
    type ParseAttempt,
    type ParseItem,
    type ParseResult,
    type PlurnkOp,
    type PlurnkStatement,
    type Position,
    type ResourceSelection,
    type RuntimeTag,
    type SendBody,
    type SendStatement,
    type TextLineMarker,
    type TodoStatement,
    type WorkStatement,
} from "@plurnk/plurnk-contracts";
import { parseMatcher } from "./MatcherSyntax.ts";
import { parseLineMarker, parseRangeMarker, parseTextLineMarker, type Advise } from "./ScopeSyntax.ts";
import { parsePath, targetMembers } from "./TargetSyntax.ts";

export interface CodeModeOptions {
    readonly executors?: readonly string[];
}

const PLURNK_RUNTIME_TOOLS: ReadonlySet<string> = new Set([
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

const BUILTIN_STANDALONE_EXECUTORS: ReadonlySet<string> = new Set([
    "sh",
    "js",
    "python3",
]);

const CORE_OP_MAP: ReadonlyMap<string, PlurnkOp> = new Map(
    PLURNK_OPS.map((op) => [op.toLowerCase(), op]),
);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

export const propAccess = (name: string): string =>
    IDENT.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;

const spelledTarget = (target: { kind: string; raw: string; fragment?: string | null }): string =>
    target.kind === "local" && target.fragment !== undefined && target.fragment !== null
        ? `${target.raw}#${target.fragment}`
        : target.raw;

const formatRange = (lineMarker: { readonly marks: readonly (number | string)[] } | null): string | undefined =>
    lineMarker === null ? undefined : lineMarker.marks.join(",");

const formatAside = (aside: string | null): string =>
    aside === null || aside.length === 0 ? "" : ` // ${aside.replaceAll(/\r?\n/gu, " ")}`;

const isObjectLiteralString = (raw: string): boolean => {
    const trimmed = raw.trim();
    return trimmed.startsWith("{") && trimmed.endsWith("}");
};

export const stringifyStatement = (statement: PlurnkStatement): string => {
    if (isExecution(statement)) {
        const runtime = statement.runtime;
        if (
            runtime === "plurnk"
            && statement.target !== null
            && statement.metadata === null
            && statement.lineMarker === null
        ) {
            const tool = spelledTarget(statement.target);
            const body = statement.body;
            const argStr = body === null || body === ""
                ? ""
                : isObjectLiteralString(body)
                    ? body.trim()
                    : JSON.stringify(body);
            return `await plurnk${propAccess(tool)}(${argStr});${formatAside(statement.aside)}`;
        }
        if (BUILTIN_STANDALONE_EXECUTORS.has(runtime) || statement.target === null) {
            if (
                !BUILTIN_STANDALONE_EXECUTORS.has(runtime)
                && statement.target === null
                && statement.lineMarker === null
                && statement.metadata === null
            ) {
                const body = statement.body;
                const argStr = body === null || body === ""
                    ? ""
                    : isObjectLiteralString(body)
                        ? body.trim()
                        : JSON.stringify(body);
                return `await plurnk${propAccess(runtime)}(${argStr});${formatAside(statement.aside)}`;
            }
            const args: Record<string, unknown> = {};
            if (statement.target !== null) {
                args[BUILTIN_STANDALONE_EXECUTORS.has(runtime) ? "cwd" : "target"] = spelledTarget(statement.target);
            }
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.metadata !== null) args.metadata = statement.metadata;
            if (statement.body !== null && statement.body.length > 0) {
                const bodyKey = runtime === "sh" ? "command" : (runtime === "js" || runtime === "python3" ? "code" : "body");
                args[bodyKey] = statement.body;
            }
            return `await plurnk${propAccess(runtime)}(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
        const tool = spelledTarget(statement.target);
        const body = statement.body;
        let argStr = body === null || body === ""
            ? ""
            : isObjectLiteralString(body)
                ? body.trim()
                : JSON.stringify(body);
        if (statement.metadata !== null || statement.lineMarker !== null) {
            const opts: Record<string, unknown> = {};
            if (statement.lineMarker !== null) opts.range = formatRange(statement.lineMarker);
            if (statement.metadata !== null) opts.metadata = statement.metadata;
            argStr = `${argStr === "" ? "null" : argStr}, ${JSON.stringify(opts)}`;
        }
        return `await ${runtime}${propAccess(tool)}(${argStr});${formatAside(statement.aside)}`;
    }

    switch (statement.op) {
        case "READ":
        case "FIND": {
            const method = statement.op.toLowerCase();
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.path = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.matcher !== null) args.pattern = statement.matcher.raw;
            if (statement.metadata !== null) args.metadata = statement.metadata;
            return `await plurnk.${method}(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
        case "EDIT": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.path = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.matcher !== null) args.pattern = statement.matcher.raw;
            if (statement.metadata !== null) args.metadata = statement.metadata;
            if (statement.body !== null && statement.body.length > 0) args.content = statement.body;
            return `await plurnk.edit(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
        case "COPY":
        case "MOVE": {
            const method = statement.op.toLowerCase();
            const formatSel = (sel: ResourceSelection): unknown => {
                if (sel.lineMarker === null && sel.matcher === null && sel.metadata === null) {
                    return spelledTarget(sel.target);
                }
                const obj: Record<string, unknown> = { path: spelledTarget(sel.target) };
                if (sel.lineMarker !== null) obj.range = formatRange(sel.lineMarker);
                if (sel.matcher !== null) obj.pattern = sel.matcher.raw;
                if (sel.metadata !== null) obj.metadata = sel.metadata;
                return obj;
            };
            const args = { from: formatSel(statement.source), to: formatSel(statement.destination) };
            return `await plurnk.${method}(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
        case "KILL": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.path = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.matcher !== null) args.pattern = statement.matcher.raw;
            if (statement.metadata !== null) args.metadata = statement.metadata;
            if (statement.body !== null && statement.body.length > 0) args.note = statement.body;
            return `await plurnk.kill(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
        case "NOTE":
        case "TODO": {
            const method = statement.op.toLowerCase();
            const args: Record<string, unknown> = {};
            if (statement.body !== null && statement.body.length > 0) args.text = statement.body;
            return `await plurnk.${method}(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
        case "WORK":
        case "FORK":
        case "BARE": {
            const method = statement.op.toLowerCase();
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            if (statement.metadata !== null) args.metadata = statement.metadata;
            args.prompt = statement.body;
            return `await plurnk.${method}(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
        case "SEND": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.metadata !== null) args.metadata = statement.metadata;
            if (statement.body !== null && statement.body.raw.length > 0) args.text = statement.body.raw;
            return `await plurnk.send(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
        case "DONE":
        case "FAIL": {
            const method = statement.op.toLowerCase();
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            if (statement.metadata !== null) args.metadata = statement.metadata;
            if (statement.body !== null && statement.body.raw.length > 0) args.text = statement.body.raw;
            return `await plurnk.${method}(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
        case "WAIT": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            if (statement.seconds !== null) args.seconds = statement.seconds;
            if (statement.body !== null && statement.body.length > 0) args.text = statement.body;
            return `await plurnk.wait(${JSON.stringify(args)});${formatAside(statement.aside)}`;
        }
    }
};

const toSendBody = (raw: string): SendBody => {
    let json: unknown = null;
    try { json = JSON.parse(raw); } catch { /* best-effort */ }
    return { raw, json };
};

const toStringValue = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (value === null || value === undefined) return "";
    return JSON.stringify(value);
};

const toMetadataArray = (value: unknown): string[] | null => {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) {
        if (value.length === 0) return null;
        return value.map((item) => typeof item === "string" ? item : JSON.stringify(item));
    }
    if (typeof value === "string") return [value];
    if (typeof value === "number" || typeof value === "boolean") return [String(value)];
    if (isRecord(value)) return [JSON.stringify(value)];
    return null;
};

const toRangeString = (value: unknown, pos: Position): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
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

const toLineMarker = (value: unknown, pos: Position, rangeMode = false, advise?: Advise): LineMarker | null => {
    const raw = toRangeString(value, pos);
    if (raw === null) return null;
    return rangeMode ? parseRangeMarker(raw, pos, advise) : parseLineMarker(raw, pos);
};

const toTextLineMarker = (value: unknown, pos: Position, advise?: Advise): TextLineMarker | null => {
    const raw = toRangeString(value, pos);
    if (raw === null) return null;
    return parseTextLineMarker(raw, pos, advise);
};

const toMatcherBody = (value: unknown, op: string, pos: Position, advise?: Advise): MatcherBody | null => {
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
        return parseMatcher(value, op, pos, advise);
    }
    if (isRecord(value) && typeof value.dialect === "string" && typeof value.raw === "string") {
        return parseMatcher(value.raw, op, pos, advise);
    }
    throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid pattern ${JSON.stringify(value)}`, "error",
        'Write a pattern string such as `"/needle/i"`, `"$..items"`, or `"*.ts"`.');
};

const escapeRegexLiteral = (literal: string): string =>
    literal.replaceAll(/[.*+?^${}()|[\]\\/]/gu, "\\$&").replaceAll("\r", "\\r").replaceAll("\n", "\\n");

const oldTextToMatcher = (oldText: string, pos: Position): MatcherBody => {
    if (oldText.length === 0) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "oldText cannot be empty", "error",
            'Provide non-empty `oldText` to match, or use `range` / `content` for line-scoped or whole-file edits.');
    }
    if (!/[\r\n]/u.test(oldText) && !/^(?:\/|\$|~|&|\^)/u.test(oldText)) {
        return { dialect: "glob", raw: oldText };
    }
    const pattern = escapeRegexLiteral(oldText);
    return { dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" };
};

const parseSelectionInput = (
    input: unknown,
    op: "COPY" | "MOVE",
    role: "from" | "to",
    pos: Position,
    advise?: Advise,
): ResourceSelection => {
    if (typeof input === "string") {
        const target = parsePath(input, pos);
        if (target === null) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires a non-empty '${role}' target.`, "error",
                `await plurnk.${op.toLowerCase()}({ from: "source", to: "destination" });`);
        }
        return { target, lineMarker: null, matcher: null, metadata: null };
    }
    if (isRecord(input)) {
        const rawPath = input.path ?? input.target ?? input.uri;
        if (typeof rawPath !== "string" || rawPath.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires a '${role}.path' target.`, "error",
                `await plurnk.${op.toLowerCase()}({ from: "source", to: "destination" });`);
        }
        const target = parsePath(rawPath, pos);
        if (target === null) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires a non-empty '${role}' target.`, "error");
        }
        const lineMarker = toTextLineMarker(input.range ?? input.lines ?? input.scope, pos, advise);
        const matcher = toMatcherBody(input.pattern ?? input.matcher ?? input.query, op, pos, advise);
        const metadata = toMetadataArray(input.metadata ?? (input.headers !== undefined ? { headers: input.headers } : undefined));
        return { target, lineMarker, matcher, metadata };
    }
    throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires both from and to targets.`, "error",
        `await plurnk.${op.toLowerCase()}({ from: "source", to: "destination" });`);
};

type Chunk =
    | { readonly kind: "code"; readonly text: string; readonly position: Position; readonly defaultAside: string | null }
    | { readonly kind: "text"; readonly text: string; readonly position: Position }
    | { readonly kind: "advisory"; readonly message: string; readonly position: Position };

// Pre-scan Markdown fences that wrap Code Mode statements so fenced Code Mode unwraps with a warning,
// while non-Code-Mode fenced blocks in outside prose remain untouched.
const unwrapCodeModeFences = (input: string): { readonly source: string; readonly advisories: ReadonlyArray<{ readonly position: Position; readonly message: string }> } => {
    const lines = input.split("\n");
    const advisories: Array<{ readonly position: Position; readonly message: string }> = [];
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
        if (closeIdx === -1) {
            i += 1;
            continue;
        }
        const inner = lines.slice(i + 1, closeIdx).join("\n");
        const lang = (openMatch[3].trim().split(/\s+/u)[0] ?? "").toLowerCase();
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

const CODE_LINE_START = /^ {0,3}(?:await\s+[A-Za-z_$]|plurnk\b|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(|(?:const|let|var|for|while|if|switch|try|function)\b|\/\/|\/\*)/u;
const CODE_CONTINUATION_START = /^[ \t]*(?:await\s+[A-Za-z_$]|plurnk\b|[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(|(?:const|let|var|for|while|if|switch|try|function)\b|\/\/|\/\*)/u;
const CONTAINS_CALL = /\bplurnk\s*(?:\.|\[|\()|\bawait\s+[A-Za-z_$][A-Za-z0-9_$-]*\s*\(|(?:await\s+)?[A-Za-z_$][A-Za-z0-9_$-]*\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\(/u;

// Split input into top-level Code Mode statement chunks, outside text paragraphs, and any truncated EOF tail.
const scanChunks = (rawInput: string): {
    readonly chunks: readonly Chunk[];
    readonly unparsedTail?: { readonly from: Position; readonly reason: string };
} => {
    const { source, advisories } = unwrapCodeModeFences(rawInput);
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
        let prevSigChar = "";
        let trailingAside: string | null = null;

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
                parenDepth += 1;
                openedCall = true;
                prevSigChar = ch;
                i += 1;
                continue;
            }
            if (ch === ")") {
                if (parenDepth > 0) parenDepth -= 1;
                prevSigChar = ch;
                i += 1;
                if (openedCall && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                    // Consume optional `.join(...)` or whitespace, `;`, and trailing `// aside` on the same line.
                    while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\r")) i += 1;
                    if (source[i] === ";") {
                        i += 1;
                        while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\r")) i += 1;
                    }
                    if (source[i] === "/" && source[i + 1] === "/") {
                        const eol = source.indexOf("\n", i + 2);
                        trailingAside = (eol === -1 ? source.slice(i + 2) : source.slice(i + 2, eol)).replace(/\r$/u, "").trim();
                        i = eol === -1 ? source.length : eol;
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
                if (braceDepth > 0) braceDepth -= 1;
                prevSigChar = ch;
                i += 1;
                if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && !openedCall) {
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

        const chunkText = source.slice(startOffset, i);
        const unclosed = inString !== null || inBlockComment || parenDepth > 0 || braceDepth > 0 || bracketDepth > 0
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
            // A non-call line that happened to start with `if` / `for` / `const` in prose (e.g. "if the file is missing..."):
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

        // Advance `lineIdx` to the remainder of the current line or the line after `i`.
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

interface ParsedCall {
    readonly chain: readonly string[];
    readonly args: readonly unknown[];
    readonly position: Position;
}

const TYPE_PLACEHOLDERS: Readonly<Record<string, unknown>> = {
    string: "",
    number: 0,
    integer: 0,
    boolean: false,
    object: {},
    array: [],
    any: null,
    unknown: null,
    Record: {},
    Array: [],
    ReadonlyArray: [],
};

// Direct recursive-descent parser for declarative Code Mode tool calls (`await <service>.<tool>(<literal-args>);`).
const parseCallStatements = (code: string, basePos: Position): readonly ParsedCall[] => {
    let idx = 0;

    const posAt = (offset: number): Position => {
        let line = basePos.line;
        let col = basePos.column;
        for (let i = 0; i < offset && i < code.length; i += 1) {
            if (code[i] === "\n") {
                line += 1;
                col = 0;
            } else {
                const cp = code.codePointAt(i)!;
                if (cp > 0xffff) i += 1;
                col += 1;
            }
        }
        return { line, column: col };
    };

    const fail = (offset: number, message: string, recovery?: string): never => {
        const p = posAt(offset);
        throw new PlurnkParseError(
            p.line,
            p.column,
            "parser",
            message,
            "error",
            recovery ?? "Write valid Code Mode calls such as `await plurnk.read({ path: \"file.txt\" });`.",
        );
    };

    const skipTrivia = (): void => {
        while (idx < code.length) {
            const ch = code[idx];
            if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
                idx += 1;
                continue;
            }
            if (ch === "/" && code[idx + 1] === "/") {
                const eol = code.indexOf("\n", idx + 2);
                idx = eol === -1 ? code.length : eol + 1;
                continue;
            }
            if (ch === "/" && code[idx + 1] === "*") {
                const close = code.indexOf("*/", idx + 2);
                if (close === -1) fail(idx, "Unterminated block comment.");
                idx = close + 2;
                continue;
            }
            break;
        }
    };

    const readStringLiteral = (): string => {
        const quote = code[idx];
        const start = idx;
        idx += 1;
        let out = "";
        while (idx < code.length) {
            const ch = code[idx];
            if (ch === quote) {
                idx += 1;
                return out;
            }
            if (quote !== "`" && (ch === "\n" || ch === "\r")) {
                fail(start, "Unterminated string literal.");
            }
            if (ch === "\\") {
                idx += 1;
                if (idx >= code.length) fail(start, "Unterminated string escape.");
                const esc = code[idx];
                idx += 1;
                switch (esc) {
                    case "n": out += "\n"; break;
                    case "r": out += "\r"; break;
                    case "t": out += "\t"; break;
                    case "b": out += "\b"; break;
                    case "f": out += "\f"; break;
                    case "v": out += "\v"; break;
                    case "0": out += "\0"; break;
                    case "\\": out += "\\"; break;
                    case "'": out += "'"; break;
                    case '"': out += '"'; break;
                    case "`": out += "`"; break;
                    case "$": out += "$"; break;
                    case "\n": break;
                    case "\r":
                        if (code[idx] === "\n") idx += 1;
                        break;
                    case "x": {
                        const hex = code.slice(idx, idx + 2);
                        if (!/^[0-9a-fA-F]{2}$/u.test(hex)) fail(idx - 2, `Invalid hex escape \`\\x${hex}\`.`);
                        out += String.fromCharCode(Number.parseInt(hex, 16));
                        idx += 2;
                        break;
                    }
                    case "u": {
                        if (code[idx] === "{") {
                            const closeBrace = code.indexOf("}", idx + 1);
                            const hex = closeBrace === -1 ? "" : code.slice(idx + 1, closeBrace);
                            if (!/^[0-9a-fA-F]{1,6}$/u.test(hex)) fail(idx - 2, "Invalid unicode escape.");
                            out += String.fromCodePoint(Number.parseInt(hex, 16));
                            idx = closeBrace + 1;
                        } else {
                            const hex = code.slice(idx, idx + 4);
                            if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail(idx - 2, `Invalid unicode escape \`\\u${hex}\`.`);
                            out += String.fromCharCode(Number.parseInt(hex, 16));
                            idx += 4;
                        }
                        break;
                    }
                    default:
                        out += esc;
                        break;
                }
                continue;
            }
            out += ch;
            idx += 1;
        }
        fail(start, "Unterminated string literal.");
        return out;
    };

    const skipTypeSuffix = (): void => {
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === "<") {
                let depth = 1;
                idx += 1;
                while (idx < code.length && depth > 0) {
                    if (code[idx] === "<") depth += 1;
                    else if (code[idx] === ">") depth -= 1;
                    idx += 1;
                }
                continue;
            }
            if (code[idx] === "[" && code[idx + 1] === "]") {
                idx += 2;
                continue;
            }
            if (code[idx] === "|" && code[idx + 1] !== "|") {
                idx += 1;
                readPrimaryValue();
                continue;
            }
            break;
        }
    };

    const readObjectLiteral = (): Record<string, unknown> => {
        const start = idx;
        idx += 1; // consume `{`
        const obj: Record<string, unknown> = {};
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === "}") {
                idx += 1;
                return obj;
            }
            let key: string;
            const ch = code[idx];
            if (ch === '"' || ch === "'" || ch === "`") {
                key = readStringLiteral();
            } else {
                const keyMatch = /^[A-Za-z0-9_$-]+/u.exec(code.slice(idx));
                if (keyMatch === null) {
                    return fail(idx, `Expected property name in object literal, found \`${code.slice(idx, idx + 12)}\`.`);
                }
                key = keyMatch[0];
                idx += key.length;
            }
            skipTrivia();
            if (code[idx] === "?") {
                idx += 1;
                skipTrivia();
            }
            if (code[idx] !== ":") {
                fail(idx, `Expected \`:\` after property name \`${key}\`.`);
            }
            idx += 1;
            const value = readValueExpr();
            obj[key] = value;
            skipTrivia();
            if (code[idx] === "," || code[idx] === ";") {
                idx += 1;
                continue;
            }
            if (code[idx] === "}") {
                idx += 1;
                return obj;
            }
            fail(idx, `Expected \`,\` or \`}\` in object literal after \`${key}\`.`);
        }
        fail(start, "Unterminated object literal.");
        return obj;
    };

    const readArrayLiteral = (): unknown => {
        const start = idx;
        idx += 1; // consume `[`
        const arr: unknown[] = [];
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === "]") {
                idx += 1;
                break;
            }
            arr.push(readValueExpr());
            skipTrivia();
            if (code[idx] === ",") {
                idx += 1;
                continue;
            }
            if (code[idx] === "]") {
                idx += 1;
                break;
            }
            fail(idx, "Expected `,` or `]` in array literal.");
        }
        if (idx >= code.length && code[idx - 1] !== "]") {
            fail(start, "Unterminated array literal.");
        }
        const saved = idx;
        skipTrivia();
        if (code.slice(idx).startsWith(".join")) {
            idx += 5;
            skipTrivia();
            if (code[idx] === "(") {
                const joinArgs = readArgList();
                const sep = joinArgs.length === 0 || joinArgs[0] === undefined ? "," : toStringValue(joinArgs[0]);
                return arr.map((item) => toStringValue(item)).join(sep);
            }
        }
        idx = saved;
        return arr;
    };

    const readRegexLiteral = (): string => {
        const start = idx;
        idx += 1; // consume `/`
        let inClass = false;
        while (idx < code.length) {
            const ch = code[idx];
            if (ch === "\\") {
                idx += 2;
                continue;
            }
            if (ch === "\n") fail(start, "Unterminated regular expression literal.");
            if (ch === "[") inClass = true;
            else if (ch === "]" && inClass) inClass = false;
            else if (ch === "/" && !inClass) {
                idx += 1;
                while (idx < code.length && /[a-z]/iu.test(code[idx])) idx += 1;
                return code.slice(start, idx);
            }
            idx += 1;
        }
        fail(start, "Unterminated regular expression literal.");
        return "";
    };

    const readPrimaryValue = (): unknown => {
        skipTrivia();
        if (idx >= code.length) fail(idx, "Unexpected end of input while reading argument value.");
        const ch = code[idx];
        if (ch === '"' || ch === "'" || ch === "`") {
            return readStringLiteral();
        }
        if (ch === "{") {
            return readObjectLiteral();
        }
        if (ch === "[") {
            return readArrayLiteral();
        }
        if (ch === "/" && code[idx + 1] !== "/" && code[idx + 1] !== "*") {
            return readRegexLiteral();
        }
        const numMatch = /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9_]+)(?:[eE][+-]?[0-9_]+)?)/u.exec(code.slice(idx));
        if (numMatch !== null) {
            idx += numMatch[0].length;
            return Number(numMatch[0].replaceAll("_", ""));
        }
        const idMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(code.slice(idx));
        if (idMatch !== null) {
            const id = idMatch[0];
            const idStart = idx;
            idx += id.length;
            if (id === "true") return true;
            if (id === "false") return false;
            if (id === "null") return null;
            if (id === "undefined") return undefined;
            if (id === "NaN") return Number.NaN;
            if (id === "Infinity") return Number.POSITIVE_INFINITY;
            if (Object.hasOwn(TYPE_PLACEHOLDERS, id)) {
                skipTypeSuffix();
                return TYPE_PLACEHOLDERS[id];
            }
            fail(idStart, `Unexpected identifier \`${id}\`; Code Mode arguments must be literal values.`);
        }
        fail(idx, `Unexpected token \`${code.slice(idx, idx + 12)}\` in argument value.`);
        return undefined;
    };

    const readValueExpr = (): unknown => {
        let value = readPrimaryValue();
        skipTypeSuffix();
        while (idx < code.length) {
            const saved = idx;
            skipTrivia();
            if (code[idx] === "+" && typeof value === "string") {
                idx += 1;
                const rhs = readPrimaryValue();
                value = `${value}${toStringValue(rhs)}`;
                continue;
            }
            idx = saved;
            break;
        }
        return value;
    };

    const readArgList = (): unknown[] => {
        const start = idx;
        idx += 1; // consume `(`
        const args: unknown[] = [];
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === ")") {
                idx += 1;
                return args;
            }
            args.push(readValueExpr());
            skipTrivia();
            if (code[idx] === ",") {
                idx += 1;
                continue;
            }
            if (code[idx] === ")") {
                idx += 1;
                return args;
            }
            fail(idx, `Expected \`,\` or \`)\` in argument list, found \`${code.slice(idx, idx + 12)}\`.`);
        }
        fail(start, "Unterminated argument list.");
        return args;
    };

    const calls: ParsedCall[] = [];
    while (idx < code.length) {
        skipTrivia();
        if (idx >= code.length) break;
        const stmtStart = idx;
        const stmtPos = posAt(stmtStart);

        const forbiddenMatch = /^(const|let|var|for|while|if|switch|try|function|return|class|import|export)\b/u.exec(code.slice(idx));
        if (forbiddenMatch !== null) {
            const after = code.slice(idx + forbiddenMatch[0].length).trimStart();
            if (!after.startsWith(".") && !after.startsWith("[")) {
                fail(
                    stmtStart,
                    `Unexpected \`${forbiddenMatch[1]}\`; Code Mode statements are declarative tool calls (\`await <service>.<tool>({ ... });\`), not general JavaScript.`,
                    "Emit one `<service>.<tool>(...)` call per statement, or use `await plurnk.js({ code: \"...\" });` to run JavaScript.",
                );
            }
        }

        const awaitMatch = /^await\b/u.exec(code.slice(idx));
        if (awaitMatch !== null) {
            const after = code.slice(idx + 5).trimStart();
            if (!after.startsWith(".") && !after.startsWith("[") && !after.startsWith("(")) {
                idx += 5;
                skipTrivia();
            }
        }

        const headMatch = /^[A-Za-z_$][A-Za-z0-9_$-]*/u.exec(code.slice(idx));
        if (headMatch === null) {
            return fail(idx, `Code Mode syntax error: unexpected \`${code.slice(idx, idx + 20)}\`.`);
        }
        const chain: string[] = [headMatch[0]];
        idx += headMatch[0].length;

        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === ".") {
                idx += 1;
                skipTrivia();
                const memberMatch = /^[A-Za-z_$][A-Za-z0-9_$-]*/u.exec(code.slice(idx));
                if (memberMatch === null) {
                    return fail(idx, "Expected tool name after `.`.");
                }
                chain.push(memberMatch[0]);
                idx += memberMatch[0].length;
                continue;
            }
            if (code[idx] === "[") {
                idx += 1;
                skipTrivia();
                const q = code[idx];
                if (q !== '"' && q !== "'" && q !== "`") {
                    fail(idx, "Expected string literal inside `[...]`.");
                }
                const member = readStringLiteral();
                skipTrivia();
                if (code[idx] !== "]") {
                    fail(idx, "Expected `]` after bracketed tool name.");
                }
                idx += 1;
                chain.push(member);
                continue;
            }
            break;
        }

        skipTrivia();
        if (code[idx] !== "(") {
            fail(stmtStart, `Statement \`${code.trim().slice(0, 80)}\` did not invoke an operation; call it with \`(...)\`.`);
        }

        const args = readArgList();
        skipTrivia();
        while (code[idx] === ";") {
            idx += 1;
            skipTrivia();
        }
        calls.push({ chain, args, position: stmtPos });
    }
    return calls;
};

const attemptVerbOf = (code: string): string => {
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

export const parseCodeMode = (
    input: string,
    options: CodeModeOptions = {},
    tier: "model" | "statements" = "model",
): ParseResult => {
    const { chunks, unparsedTail } = scanChunks(input);
    const items: ParseItem[] = [];

    const hasExplicitExecutors = options.executors !== undefined;
    const executorSpellings = new Map<string, RuntimeTag>();
    for (const builtin of BUILTIN_STANDALONE_EXECUTORS) {
        if (isExecutionOp(builtin)) {
            executorSpellings.set(builtin, builtin);
        }
    }
    executorSpellings.set("plurnk", "plurnk");
    for (const name of options.executors ?? []) {
        const lower = name.toLowerCase();
        if (isExecutionOp(lower)) {
            executorSpellings.set(lower, lower);
        }
    }
    if (executorSpellings.has("js")) {
        for (const alias of JS_ALIAS_SPELLINGS) {
            if (!executorSpellings.has(alias)) {
                executorSpellings.set(alias, "js");
            }
        }
    }

    let activePosition: Position = { line: 1, column: 0 };
    let activeDefaultAside: string | null = null;
    let activeChunkStatements: PlurnkStatement[] = [];
    let activeChunkAdvisories: PlurnkParseError[] = [];

    const advise: Advise = (pos, message) => {
        const at = pos === undefined || (pos.line === 0 && pos.column === 0) ? activePosition : pos;
        activeChunkAdvisories.push(new PlurnkParseError(at.line, at.column, "parser", message, "warning"));
    };

    const emitStatement = <T extends PlurnkStatement>(statement: T): T => {
        const withAside: T = statement.aside === null && activeDefaultAside !== null
            ? { ...statement, aside: activeDefaultAside }
            : statement;
        activeChunkStatements.push(withAside);
        return withAside;
    };

    const resolveAside = (argObj: Record<string, unknown> | null): string | null => {
        if (argObj !== null && typeof argObj.aside === "string" && argObj.aside.trim().length > 0) {
            return argObj.aside.trim();
        }
        return activeDefaultAside;
    };

    const buildReadOrFind = (op: "READ" | "FIND", args: readonly unknown[]): PlurnkStatement | PlurnkStatement[] => {
        const pos = activePosition;
        if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null))) {
            if (op === "READ") {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "READ requires a target.", "error",
                    'await plurnk.read({ path: "path/to/file" });');
            }
            return emitStatement({
                op: "FIND",
                aside: activeDefaultAside,
                target: null,
                lineMarker: null,
                matcher: null,
                metadata: null,
                body: null,
                position: pos,
            });
        }
        const first = args[0];
        if (Array.isArray(first)) {
            if (first.length === 0 && op === "READ") {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "READ requires a target.", "error",
                    'await plurnk.read({ path: "path/to/file" });');
            }
            const results: PlurnkStatement[] = [];
            for (const entry of first) {
                const sub = buildReadOrFind(op, [entry]);
                if (Array.isArray(sub)) results.push(...sub);
                else results.push(sub);
            }
            return results;
        }
        if (typeof first === "string") {
            const parsed = parsePath(first, pos);
            if (parsed === null && op === "READ") {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "READ requires a target.", "error",
                    'await plurnk.read({ path: "path/to/file" });');
            }
            const targets = parsed === null ? [null] : targetMembers(parsed);
            const second = isRecord(args[1]) ? args[1] : null;
            const aside = resolveAside(second);
            const matcher = toMatcherBody(second?.pattern ?? second?.matcher ?? second?.query, op, pos, advise);
            const metadata = toMetadataArray(second?.metadata ?? (second?.headers !== undefined ? { headers: second.headers } : undefined));
            return targets.map((target) => emitStatement(op === "READ" ? {
                op: "READ",
                aside,
                target,
                lineMarker: toTextLineMarker(second?.range ?? second?.lines ?? second?.scope, pos, advise),
                matcher,
                metadata,
                body: null,
                position: pos,
            } : {
                op: "FIND",
                aside,
                target,
                lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.scope ?? second?.limit, pos, true, advise),
                matcher,
                metadata,
                body: null,
                position: pos,
            }));
        }
        if (isRecord(first)) {
            const aside = resolveAside(first);
            const matcher = toMatcherBody(first.pattern ?? first.matcher ?? first.query, op, pos, advise);
            const metadata = toMetadataArray(first.metadata ?? (first.headers !== undefined ? { headers: first.headers } : undefined));
            const rawPaths = first.paths ?? first.targets ?? first.path ?? first.target ?? first.uri;
            if (Array.isArray(rawPaths)) {
                if (rawPaths.length === 0 && op === "READ") {
                    throw new PlurnkParseError(pos.line, pos.column, "parser", "READ requires a target.", "error",
                        'await plurnk.read({ path: "path/to/file" });');
                }
                const results: PlurnkStatement[] = [];
                for (const item of rawPaths) {
                    if (typeof item === "string") {
                        const parsed = parsePath(item, pos);
                        const members = parsed === null ? [null] : targetMembers(parsed);
                        for (const target of members) {
                            results.push(emitStatement(op === "READ" ? {
                                op: "READ",
                                aside,
                                target,
                                lineMarker: toTextLineMarker(first.range ?? first.lines ?? first.scope, pos, advise),
                                matcher,
                                metadata,
                                body: null,
                                position: pos,
                            } : {
                                op: "FIND",
                                aside,
                                target,
                                lineMarker: toLineMarker(first.range ?? first.lines ?? first.scope ?? first.limit, pos, true, advise),
                                matcher,
                                metadata,
                                body: null,
                                position: pos,
                            }));
                        }
                    } else if (isRecord(item)) {
                        const sub = buildReadOrFind(op, [{ ...first, ...item, paths: undefined, targets: undefined }]);
                        if (Array.isArray(sub)) results.push(...sub);
                        else results.push(sub);
                    }
                }
                return results;
            }
            if (rawPaths !== undefined && rawPaths !== null && typeof rawPaths !== "string") {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `${op} path must be a string`, "error");
            }
            const parsed = typeof rawPaths === "string" ? parsePath(rawPaths, pos) : null;
            if (parsed === null && op === "READ") {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "READ requires a target.", "error",
                    'await plurnk.read({ path: "path/to/file" });');
            }
            const targets = parsed === null ? [null] : targetMembers(parsed);
            return targets.map((target) => emitStatement(op === "READ" ? {
                op: "READ",
                aside,
                target,
                lineMarker: toTextLineMarker(first.range ?? first.lines ?? first.scope, pos, advise),
                matcher,
                metadata,
                body: null,
                position: pos,
            } : {
                op: "FIND",
                aside,
                target,
                lineMarker: toLineMarker(first.range ?? first.lines ?? first.scope ?? first.limit, pos, true, advise),
                matcher,
                metadata,
                body: null,
                position: pos,
            }));
        }
        throw new PlurnkParseError(pos.line, pos.column, "parser", `Invalid arguments to plurnk.${op.toLowerCase()}.`, "error");
    };

    const buildEdit = (args: readonly unknown[]): EditStatement | EditStatement[] => {
        const pos = activePosition;
        const first = args[0];
        if (typeof first === "string" && args.length >= 2) {
            const parsed = parsePath(first, pos);
            if (parsed === null) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "EDIT requires a target.", "error",
                    'await plurnk.edit({ path: "path/to/file", content: "..." });');
            }
            const body = args[1] === null || args[1] === undefined || args[1] === "" ? null : toStringValue(args[1]);
            return targetMembers(parsed).map((target) => emitStatement({
                op: "EDIT",
                aside: activeDefaultAside,
                target,
                lineMarker: null,
                matcher: null,
                metadata: null,
                body,
                position: pos,
            }));
        }
        if (!isRecord(first)) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "EDIT requires an options object with `path`.", "error",
                'await plurnk.edit({ path: "path/to/file", content: "..." });');
        }
        const rawPath = first.path ?? first.target ?? first.uri;
        if (typeof rawPath !== "string" || rawPath.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "EDIT requires a target.", "error",
                'await plurnk.edit({ path: "path/to/file", content: "..." });');
        }
        const parsed = parsePath(rawPath, pos);
        if (parsed === null) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "EDIT requires a target.", "error",
                'await plurnk.edit({ path: "path/to/file", content: "..." });');
        }
        const targets = targetMembers(parsed);
        const aside = resolveAside(first);
        const metadata = toMetadataArray(first.metadata ?? (first.headers !== undefined ? { headers: first.headers } : undefined));

        if (Array.isArray(first.edits)) {
            if (first.edits.length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", "EDIT `edits` array cannot be empty.", "error");
            }
            const statements: EditStatement[] = [];
            for (const target of targets) {
                for (const item of first.edits) {
                    if (!isRecord(item)) {
                        throw new PlurnkParseError(pos.line, pos.column, "visitor", "Each entry in `edits` must be an object.", "error");
                    }
                    const itemLineMarker = toTextLineMarker(item.range ?? item.lines ?? item.scope ?? first.range ?? first.lines ?? first.scope, pos, advise);
                    const itemMatcher = typeof item.oldText === "string"
                        ? oldTextToMatcher(item.oldText, pos)
                        : toMatcherBody(item.pattern ?? item.matcher, "EDIT", pos, advise);
                    const rawContent = item.newText ?? item.content ?? item.body ?? item.text;
                    const body = rawContent === undefined || rawContent === null || rawContent === "" ? null : toStringValue(rawContent);
                    statements.push(emitStatement({
                        op: "EDIT",
                        aside,
                        target,
                        lineMarker: itemLineMarker,
                        matcher: itemMatcher,
                        metadata,
                        body,
                        position: pos,
                    }));
                }
            }
            return statements;
        }

        const lineMarker = toTextLineMarker(first.range ?? first.lines ?? first.scope, pos, advise);
        const matcher = typeof first.oldText === "string"
            ? oldTextToMatcher(first.oldText, pos)
            : toMatcherBody(first.pattern ?? first.matcher, "EDIT", pos, advise);
        const rawBody = first.newText ?? first.content ?? first.body ?? first.text;
        const body = rawBody === undefined || rawBody === null || rawBody === "" ? null : toStringValue(rawBody);
        return targets.map((target) => emitStatement({
            op: "EDIT",
            aside,
            target,
            lineMarker,
            matcher,
            metadata,
            body,
            position: pos,
        }));
    };

    const buildTransfer = (op: "COPY" | "MOVE", args: readonly unknown[]): CopyStatement | MoveStatement => {
        const pos = activePosition;
        if (typeof args[0] === "string" && typeof args[1] === "string") {
            const source = parseSelectionInput(args[0], op, "from", pos, advise);
            const destination = parseSelectionInput(args[1], op, "to", pos, advise);
            return emitStatement({ op, aside: activeDefaultAside, source, destination, position: pos });
        }
        const first = args[0];
        if (!isRecord(first)) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires both from and to targets.`, "error",
                `await plurnk.${op.toLowerCase()}({ from: "source", to: "destination" });`);
        }
        const rawFrom = first.from ?? first.source ?? first.src;
        const rawTo = first.to ?? first.destination ?? first.dest;
        const sourceBase = parseSelectionInput(rawFrom, op, "from", pos, advise);
        const destBase = parseSelectionInput(rawTo, op, "to", pos, advise);
        const source: ResourceSelection = {
            target: sourceBase.target,
            lineMarker: sourceBase.lineMarker ?? toTextLineMarker(first.range ?? first.lines ?? first.scope ?? first.sourceRange, pos, advise),
            matcher: sourceBase.matcher ?? toMatcherBody(first.pattern ?? first.matcher ?? first.sourcePattern, op, pos, advise),
            metadata: sourceBase.metadata ?? toMetadataArray(first.metadata ?? first.sourceMetadata),
        };
        const destination: ResourceSelection = {
            target: destBase.target,
            lineMarker: destBase.lineMarker ?? toTextLineMarker(first.toRange ?? first.destinationRange ?? first.destRange, pos, advise),
            matcher: destBase.matcher ?? toMatcherBody(first.toPattern ?? first.destinationPattern, op, pos, advise),
            metadata: destBase.metadata ?? toMetadataArray(first.toMetadata ?? first.destinationMetadata),
        };
        return emitStatement({
            op,
            aside: resolveAside(first),
            source,
            destination,
            position: pos,
        });
    };

    const buildKill = (args: readonly unknown[]): KillStatement | KillStatement[] => {
        const pos = activePosition;
        const first = args[0];
        if (Array.isArray(first)) {
            if (first.length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "KILL requires a target.", "error",
                    'await plurnk.kill({ path: "log:///1/1/1/READ" });');
            }
            const results: KillStatement[] = [];
            for (const item of first) {
                const sub = buildKill([item]);
                if (Array.isArray(sub)) results.push(...sub);
                else results.push(sub);
            }
            return results;
        }
        if (typeof first === "string") {
            const parsed = parsePath(first, pos);
            if (parsed === null) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "KILL requires a target.", "error",
                    'await plurnk.kill({ path: "log:///1/1/1/READ" });');
            }
            const second = isRecord(args[1]) ? args[1] : null;
            const rawNote = typeof args[1] === "string" ? args[1] : (second?.note ?? second?.distillation ?? second?.body ?? second?.content ?? second?.text);
            const note = typeof rawNote === "string" && rawNote.trim().length > 0 ? rawNote : null;
            const lineMarker = toTextLineMarker(second?.range ?? second?.lines ?? second?.scope, pos, advise);
            const matcher = toMatcherBody(second?.pattern ?? second?.matcher, "KILL", pos, advise);
            const metadata = toMetadataArray(second?.metadata ?? second?.signal);
            const aside = resolveAside(second);
            return targetMembers(parsed).map((target, idx) => emitStatement({
                op: "KILL",
                aside,
                target,
                lineMarker,
                matcher,
                metadata,
                body: idx === 0 ? note : null,
                position: pos,
            }));
        }
        if (isRecord(first)) {
            const rawPaths = first.paths ?? first.targets ?? first.path ?? first.target ?? first.uri;
            const aside = resolveAside(first);
            const rawNote = first.note ?? first.distillation ?? first.body ?? first.content ?? first.text;
            const note = typeof rawNote === "string" && rawNote.trim().length > 0 ? rawNote : null;
            const lineMarker = toTextLineMarker(first.range ?? first.lines ?? first.scope, pos, advise);
            const matcher = toMatcherBody(first.pattern ?? first.matcher, "KILL", pos, advise);
            const metadata = toMetadataArray(first.metadata ?? first.signal);

            if (Array.isArray(rawPaths)) {
                if (rawPaths.length === 0) {
                    throw new PlurnkParseError(pos.line, pos.column, "parser", "KILL requires a target.", "error",
                        'await plurnk.kill({ path: "log:///1/1/1/READ" });');
                }
                const results: KillStatement[] = [];
                for (const [idx, item] of rawPaths.entries()) {
                    if (typeof item === "string") {
                        const parsed = parsePath(item, pos);
                        if (parsed === null) {
                            throw new PlurnkParseError(pos.line, pos.column, "parser", "KILL requires a target.", "error");
                        }
                        for (const [mIdx, target] of targetMembers(parsed).entries()) {
                            results.push(emitStatement({
                                op: "KILL",
                                aside,
                                target,
                                lineMarker,
                                matcher,
                                metadata,
                                body: idx === 0 && mIdx === 0 ? note : null,
                                position: pos,
                            }));
                        }
                    } else if (isRecord(item)) {
                        const sub = buildKill([{ ...first, ...item, paths: undefined, targets: undefined, note: idx === 0 ? note : null }]);
                        if (Array.isArray(sub)) results.push(...sub);
                        else results.push(sub);
                    }
                }
                return results;
            }
            if (typeof rawPaths !== "string" || rawPaths.length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "KILL requires a target.", "error",
                    'await plurnk.kill({ path: "log:///1/1/1/READ" });');
            }
            const parsed = parsePath(rawPaths, pos);
            if (parsed === null) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "KILL requires a target.", "error",
                    'await plurnk.kill({ path: "log:///1/1/1/READ" });');
            }
            return targetMembers(parsed).map((target, idx) => emitStatement({
                op: "KILL",
                aside,
                target,
                lineMarker,
                matcher,
                metadata,
                body: idx === 0 ? note : null,
                position: pos,
            }));
        }
        throw new PlurnkParseError(pos.line, pos.column, "parser", "KILL requires a target.", "error",
            'await plurnk.kill({ path: "log:///1/1/1/READ" });');
    };

    const buildNote = (args: readonly unknown[]): NoteStatement => {
        const pos = activePosition;
        const first = args[0];
        if (first === undefined || first === null || first === "") {
            return emitStatement({ op: "NOTE", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, body: null, position: pos });
        }
        if (typeof first === "string") {
            return emitStatement({ op: "NOTE", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, body: first, position: pos });
        }
        if (isRecord(first)) {
            const rawText = first.text ?? first.content ?? first.body ?? first.note ?? first.message;
            const body = rawText === undefined || rawText === null || rawText === "" ? null : toStringValue(rawText);
            return emitStatement({ op: "NOTE", aside: resolveAside(first), target: null, metadata: null, lineMarker: null, body, position: pos });
        }
        return emitStatement({ op: "NOTE", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, body: toStringValue(first), position: pos });
    };

    const formatTodoItem = (item: unknown): string => {
        if (typeof item === "string") {
            return /^\s*[-*]\s*\[[ xX~]\]/u.test(item) ? item : `- [ ] ${item}`;
        }
        if (isRecord(item)) {
            const text = toStringValue(item.text ?? item.content ?? item.title ?? item.task ?? "");
            const status = item.status ?? (item.completed === true || item.done === true ? "done" : "pending");
            const box = status === "done" || status === "completed" || status === "x"
                ? "[x]"
                : status === "in_progress" || status === "active" || status === "~"
                    ? "[~]"
                    : "[ ]";
            return `- ${box} ${text}`;
        }
        return `- [ ] ${toStringValue(item)}`;
    };

    const buildTodo = (args: readonly unknown[]): TodoStatement => {
        const pos = activePosition;
        const first = args[0];
        if (first === undefined || first === null || first === "") {
            return emitStatement({ op: "TODO", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, body: null, position: pos });
        }
        if (typeof first === "string") {
            return emitStatement({ op: "TODO", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, body: first, position: pos });
        }
        if (Array.isArray(first)) {
            const body = first.length === 0 ? null : first.map(formatTodoItem).join("\n");
            return emitStatement({ op: "TODO", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, body, position: pos });
        }
        if (isRecord(first)) {
            const rawItems = Array.isArray(first.items) ? first.items : (Array.isArray(first.todos) ? first.todos : null);
            if (rawItems !== null) {
                const body = rawItems.length === 0 ? null : rawItems.map(formatTodoItem).join("\n");
                return emitStatement({ op: "TODO", aside: resolveAside(first), target: null, metadata: null, lineMarker: null, body, position: pos });
            }
            const rawText = first.text ?? first.content ?? first.body;
            const body = rawText === undefined || rawText === null || rawText === "" ? null : toStringValue(rawText);
            return emitStatement({ op: "TODO", aside: resolveAside(first), target: null, metadata: null, lineMarker: null, body, position: pos });
        }
        return emitStatement({ op: "TODO", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, body: toStringValue(first), position: pos });
    };

    const buildDelegation = (op: "WORK" | "FORK" | "BARE", args: readonly unknown[]): WorkStatement | ForkStatement | BareStatement => {
        const pos = activePosition;
        if (typeof args[0] === "string" && typeof args[1] === "string") {
            const target = parsePath(args[0], pos);
            return emitStatement({ op, aside: activeDefaultAside, target, metadata: null, lineMarker: null, body: args[1], position: pos });
        }
        if (typeof args[0] === "string") {
            return emitStatement({ op, aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, body: args[0], position: pos });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            const rawTarget = first.target ?? first.path ?? first.uri ?? (typeof first.session === "string"
                ? (first.session.includes("://") ? first.session : `session://${first.session}`)
                : undefined);
            const target = typeof rawTarget === "string" && rawTarget.length > 0 ? parsePath(rawTarget, pos) : null;
            let metadata = toMetadataArray(first.metadata);
            if (metadata === null && (first.model !== undefined || first.effort !== undefined || first.persona !== undefined)) {
                const opts: Record<string, unknown> = {};
                if (first.model !== undefined) opts.model = first.model;
                if (first.effort !== undefined) opts.effort = first.effort;
                if (first.persona !== undefined) opts.persona = first.persona;
                metadata = [JSON.stringify(opts)];
            }
            const rawPrompt = first.prompt ?? first.body ?? first.content ?? first.text ?? first.message;
            const body = rawPrompt === undefined || rawPrompt === null ? "" : toStringValue(rawPrompt);
            return emitStatement({ op, aside: resolveAside(first), target, metadata, lineMarker: null, body, position: pos });
        }
        return emitStatement({ op, aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, body: "", position: pos });
    };

    const buildSend = (args: readonly unknown[]): SendStatement => {
        const pos = activePosition;
        if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
            return emitStatement({ op: "SEND", aside: activeDefaultAside, target: null, lineMarker: null, metadata: null, body: null, position: pos });
        }
        if (typeof args[0] === "string" && args.length >= 2 && (typeof args[1] === "string" || isRecord(args[1]))) {
            const target = parsePath(args[0], pos);
            if (typeof args[1] === "string") {
                return emitStatement({ op: "SEND", aside: activeDefaultAside, target, lineMarker: null, metadata: null, body: args[1].length === 0 ? null : toSendBody(args[1]), position: pos });
            }
            const second = args[1];
            const rawText = second.text ?? second.content ?? second.body ?? second.message;
            const body = second.json !== undefined
                ? { raw: JSON.stringify(second.json), json: second.json }
                : (rawText === undefined || rawText === null || rawText === "" ? null : toSendBody(toStringValue(rawText)));
            return emitStatement({
                op: "SEND",
                aside: resolveAside(second),
                target,
                lineMarker: toLineMarker(second.range ?? second.lines ?? second.scope, pos),
                metadata: toMetadataArray(second.metadata ?? second.signal),
                body,
                position: pos,
            });
        }
        if (typeof args[0] === "string") {
            return emitStatement({ op: "SEND", aside: activeDefaultAside, target: null, lineMarker: null, metadata: null, body: toSendBody(args[0]), position: pos });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            const rawTarget = first.target ?? first.to ?? first.path ?? first.uri ?? (typeof first.session === "string"
                ? (first.session.includes("://") ? first.session : `session://${first.session}`)
                : undefined);
            const target = typeof rawTarget === "string" && rawTarget.length > 0 ? parsePath(rawTarget, pos) : null;
            const lineMarker = toLineMarker(first.range ?? first.lines ?? first.scope, pos);
            const metadata = toMetadataArray(first.metadata ?? first.signal ?? (first.headers !== undefined ? { headers: first.headers } : undefined));
            const rawText = first.text ?? first.content ?? first.body ?? first.message;
            const body = first.json !== undefined
                ? { raw: JSON.stringify(first.json), json: first.json }
                : (rawText === undefined || rawText === null || rawText === "" ? null : toSendBody(toStringValue(rawText)));
            return emitStatement({ op: "SEND", aside: resolveAside(first), target, lineMarker, metadata, body, position: pos });
        }
        return emitStatement({ op: "SEND", aside: activeDefaultAside, target: null, lineMarker: null, metadata: null, body: toSendBody(toStringValue(args[0])), position: pos });
    };

    const buildConclusion = (op: "DONE" | "FAIL", args: readonly unknown[]): DoneStatement | FailStatement => {
        const pos = activePosition;
        if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
            return emitStatement({ op, aside: activeDefaultAside, target: null, lineMarker: null, metadata: null, body: null, position: pos });
        }
        if (typeof args[0] === "string" && typeof args[1] === "string") {
            const target = parsePath(args[0], pos);
            return emitStatement({ op, aside: activeDefaultAside, target, lineMarker: null, metadata: null, body: args[1].length === 0 ? null : toSendBody(args[1]), position: pos });
        }
        if (typeof args[0] === "string") {
            return emitStatement({ op, aside: activeDefaultAside, target: null, lineMarker: null, metadata: null, body: toSendBody(args[0]), position: pos });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            const rawTarget = first.target ?? first.to ?? first.path ?? first.uri;
            const target = typeof rawTarget === "string" && rawTarget.length > 0 ? parsePath(rawTarget, pos) : null;
            const metadata = toMetadataArray(first.metadata);
            const rawText = first.text ?? first.content ?? first.body ?? first.message ?? first.reason ?? first.summary;
            const body = first.json !== undefined
                ? { raw: JSON.stringify(first.json), json: first.json }
                : (rawText === undefined || rawText === null || rawText === "" ? null : toSendBody(toStringValue(rawText)));
            return emitStatement({ op, aside: resolveAside(first), target, lineMarker: null, metadata, body, position: pos });
        }
        return emitStatement({ op, aside: activeDefaultAside, target: null, lineMarker: null, metadata: null, body: toSendBody(toStringValue(args[0])), position: pos });
    };

    const buildWait = (args: readonly unknown[]): DispositionStatement => {
        const pos = activePosition;
        if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
            return emitStatement({ op: "WAIT", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, seconds: null, body: null, position: pos });
        }
        if (typeof args[0] === "number") {
            const seconds = Number.isFinite(args[0]) && args[0] >= 0 ? args[0] : null;
            const body = typeof args[1] === "string" && args[1].length > 0 ? args[1] : null;
            return emitStatement({ op: "WAIT", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, seconds, body, position: pos });
        }
        if (typeof args[0] === "string") {
            return emitStatement({ op: "WAIT", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, seconds: null, body: args[0], position: pos });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            const rawTarget = first.target ?? first.for ?? first.path ?? first.uri ?? (typeof first.session === "string"
                ? (first.session.includes("://") ? first.session : `session://${first.session}`)
                : undefined);
            const target = typeof rawTarget === "string" && rawTarget.length > 0 ? parsePath(rawTarget, pos) : null;
            const rawSeconds = first.seconds ?? first.duration;
            let seconds: number | null = null;
            if (typeof rawSeconds === "number" && Number.isFinite(rawSeconds) && rawSeconds >= 0) {
                seconds = rawSeconds;
            } else if (rawSeconds !== undefined && rawSeconds !== null) {
                advise(pos, `Ignored WAIT duration ${JSON.stringify(rawSeconds)}.`);
            }
            const rawText = first.text ?? first.body ?? first.content ?? first.message ?? first.reason;
            const body = rawText === undefined || rawText === null || rawText === "" ? null : toStringValue(rawText);
            return emitStatement({ op: "WAIT", aside: resolveAside(first), target, metadata: null, lineMarker: null, seconds, body, position: pos });
        }
        return emitStatement({ op: "WAIT", aside: activeDefaultAside, target: null, metadata: null, lineMarker: null, seconds: null, body: toStringValue(args[0]), position: pos });
    };

    const buildPlurnkTool = (toolName: string, args: readonly unknown[]): ExecStatement => {
        const pos = activePosition;
        const target = parsePath(toolName, pos);
        const first = args[0];
        const second = isRecord(args[1]) ? args[1] : null;
        let body: string | null = null;
        if (first !== undefined && first !== null && first !== "") {
            body = typeof first === "string" ? first : JSON.stringify(first);
        }
        return emitStatement({
            runtime: "plurnk",
            aside: resolveAside(second),
            target,
            lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.scope, pos),
            metadata: toMetadataArray(second?.metadata),
            body,
            position: pos,
        });
    };

    const buildStandaloneExec = (runtime: RuntimeTag, args: readonly unknown[]): ExecStatement => {
        const pos = activePosition;
        if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
            return emitStatement({
                runtime,
                aside: activeDefaultAside,
                target: null,
                lineMarker: null,
                metadata: null,
                body: null,
                position: pos,
            });
        }
        if (typeof args[0] === "string" && args.length >= 2) {
            const target = parsePath(args[0], pos);
            const second = args[1];
            const body = second === null || second === undefined || second === "" ? null : (typeof second === "string" ? second : JSON.stringify(second));
            const third = isRecord(args[2]) ? args[2] : null;
            return emitStatement({
                runtime,
                aside: resolveAside(third),
                target,
                lineMarker: toLineMarker(third?.range ?? third?.lines ?? third?.scope, pos),
                metadata: toMetadataArray(third?.metadata ?? (third?.env !== undefined ? { env: third.env } : undefined)),
                body,
                position: pos,
            });
        }
        if (typeof args[0] === "string") {
            return emitStatement({
                runtime,
                aside: activeDefaultAside,
                target: null,
                lineMarker: null,
                metadata: null,
                body: args[0],
                position: pos,
            });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            const EXEC_ENVELOPE_KEYS = new Set([
                "command", "code", "body", "cwd", "script", "target", "path", "args", "env", "metadata", "range", "lines", "scope", "aside",
            ]);
            const hasEnvelopeKey = Object.keys(first).some((k) => EXEC_ENVELOPE_KEYS.has(k));
            if (!hasEnvelopeKey) {
                const second = isRecord(args[1]) ? args[1] : null;
                return emitStatement({
                    runtime,
                    aside: resolveAside(second),
                    target: null,
                    lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.scope, pos),
                    metadata: toMetadataArray(second?.metadata),
                    body: Object.keys(first).length === 0 ? null : JSON.stringify(first),
                    position: pos,
                });
            }
            const rawTarget = first.cwd ?? first.script ?? first.target ?? first.path;
            const target = typeof rawTarget === "string" && rawTarget.length > 0 ? parsePath(rawTarget, pos) : null;
            const lineMarker = toLineMarker(first.range ?? first.lines ?? first.scope, pos);
            const metadata = toMetadataArray(first.metadata ?? (first.env !== undefined ? { env: first.env } : undefined));
            let body: string | null = null;
            const rawBody = first.command ?? first.code ?? first.body;
            if (rawBody !== undefined && rawBody !== null && rawBody !== "") {
                body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
            } else if (Array.isArray(first.args) && first.args.length > 0) {
                body = first.args.map((arg) => {
                    const str = toStringValue(arg);
                    return /[\s"']/u.test(str) ? JSON.stringify(str) : str;
                }).join(" ");
            } else if (typeof first.args === "string" && first.args.length > 0) {
                body = first.args;
            }
            return emitStatement({
                runtime,
                aside: resolveAside(first),
                target,
                lineMarker,
                metadata,
                body,
                position: pos,
            });
        }
        return emitStatement({
            runtime,
            aside: activeDefaultAside,
            target: null,
            lineMarker: null,
            metadata: null,
            body: JSON.stringify(args[0]),
            position: pos,
        });
    };

    const buildMcpCall = (rawServer: string, rawTool: string, args: readonly unknown[]): ExecStatement => {
        const pos = activePosition;
        const lowerServer = rawServer.toLowerCase();
        if (!isExecutionOp(lowerServer)) {
            throw new PlurnkParseError(pos.line, pos.column, "parser",
                `Invalid MCP runtime name ${JSON.stringify(rawServer)}.`, "error");
        }
        if (rawServer !== lowerServer) {
            if (executorSpellings.has(lowerServer)) {
                advise(pos, `Runtime \`${rawServer}\` was read as \`${lowerServer}\`.`);
            } else {
                throw new PlurnkParseError(pos.line, pos.column, "parser",
                    `Unknown runtime ${JSON.stringify(rawServer)}; runtime names are lowercase.`, "error");
            }
        }
        const runtime = lowerServer;
        const target = parsePath(rawTool, pos);
        const first = args[0];
        const second = isRecord(args[1]) ? args[1] : null;
        let body: string | null = null;
        if (first !== undefined && first !== null && first !== "") {
            body = typeof first === "string" ? first : JSON.stringify(first);
        }
        return emitStatement({
            runtime,
            aside: resolveAside(second),
            target,
            lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.scope, pos),
            metadata: toMetadataArray(second?.metadata ?? (second?.env !== undefined ? { env: second.env } : undefined)),
            body,
            position: pos,
        });
    };

    const dispatchPlurnkTool = (prop: string, args: readonly unknown[]): void => {
        const lower = prop.toLowerCase();
        const explicitSingleExecutor = options.executors?.length === 1 && options.executors[0]?.toLowerCase() === lower;
        const coreOp = explicitSingleExecutor ? undefined : CORE_OP_MAP.get(lower);
        if (coreOp !== undefined) {
            if (prop !== lower) {
                advise(activePosition, `\`plurnk.${prop}\` was read as \`plurnk.${lower}\`.`);
            }
            switch (coreOp) {
                case "READ":
                case "FIND":
                    buildReadOrFind(coreOp, args);
                    return;
                case "EDIT":
                    buildEdit(args);
                    return;
                case "COPY":
                case "MOVE":
                    buildTransfer(coreOp, args);
                    return;
                case "KILL":
                    buildKill(args);
                    return;
                case "NOTE":
                    buildNote(args);
                    return;
                case "TODO":
                    buildTodo(args);
                    return;
                case "WORK":
                case "FORK":
                case "BARE":
                    buildDelegation(coreOp, args);
                    return;
                case "SEND":
                    buildSend(args);
                    return;
                case "DONE":
                case "FAIL":
                    buildConclusion(coreOp, args);
                    return;
                case "WAIT":
                    buildWait(args);
                    return;
            }
        }
        if (PLURNK_RUNTIME_TOOLS.has(lower) || (lower.includes("|") && lower.split("|").every((part) => PLURNK_RUNTIME_TOOLS.has(part)))) {
            if (prop !== lower) {
                advise(activePosition, `\`plurnk.${prop}\` was read as \`plurnk.${lower}\`.`);
            }
            buildPlurnkTool(lower, args);
            return;
        }
        if (lower === "plurnk") {
            if (typeof args[0] === "string" && args.length > 1) {
                buildPlurnkTool(args[0], args.slice(1));
                return;
            }
            buildStandaloneExec("plurnk", args);
            return;
        }
        const knownRuntime = executorSpellings.get(lower);
        if (knownRuntime !== undefined) {
            if (prop !== knownRuntime && !JS_ALIAS_SPELLINGS.has(lower)) {
                advise(activePosition, `\`plurnk.${prop}\` was read as \`plurnk.${knownRuntime}\`.`);
            }
            buildStandaloneExec(knownRuntime, args);
            return;
        }
        const explicitOnlyPlurnk = options.executors?.length === 1 && options.executors[0]?.toLowerCase() === "plurnk";
        if (explicitOnlyPlurnk && !INTERNAL_ROW_OPS.has(lower)) {
            buildPlurnkTool(prop, args);
            return;
        }
        if (isExecutionOp(prop) && args.length > 0) {
            buildStandaloneExec(prop, args);
            return;
        }
        throw new PlurnkParseError(
            activePosition.line,
            activePosition.column,
            "parser",
            `Unknown operation \`plurnk.${prop}\`.`,
            "error",
            "Use a core operation (`plurnk.read`, `plurnk.edit`, `plurnk.done`, ...) or an MCP tool (`<service>.<tool>(...)`).",
        );
    };

    const dispatchCall = (call: ParsedCall): void => {
        activePosition = call.position;
        const { chain, args } = call;
        if (chain.length === 1) {
            const head = chain[0];
            const lower = head.toLowerCase();
            if (lower === "plurnk") {
                if (typeof args[0] === "string" && args.length > 1) {
                    buildPlurnkTool(args[0], args.slice(1));
                    return;
                }
                buildStandaloneExec("plurnk", args);
                return;
            }
            const knownRuntime = executorSpellings.get(lower);
            if (knownRuntime !== undefined) {
                buildStandaloneExec(knownRuntime, args);
                return;
            }
            if (!hasExplicitExecutors && isExecutionOp(head)) {
                buildStandaloneExec(head, args);
                return;
            }
            throw new PlurnkParseError(
                call.position.line,
                call.position.column,
                "parser",
                `Unknown operation \`${head}\`.`,
                "error",
                "Write `await plurnk.<op>({ ... });` or `await <service>.<tool>({ ... });`.",
            );
        }
        if (chain.length === 2) {
            const [service = "", tool = ""] = chain;
            if (service === "plurnk") {
                dispatchPlurnkTool(tool, args);
                return;
            }
            buildMcpCall(service, tool, args);
            return;
        }
        throw new PlurnkParseError(
            call.position.line,
            call.position.column,
            "parser",
            `Invalid call target \`${chain.join(".")}\`.`,
            "error",
            "Write `await <service>.<tool>({ ... });`.",
        );
    };

    for (const chunk of chunks) {
        if (chunk.kind === "advisory") {
            items.push({
                kind: "error",
                error: new PlurnkParseError(chunk.position.line, chunk.position.column, "parser", chunk.message, "warning"),
            });
            continue;
        }
        if (chunk.kind === "text") {
            if (tier === "model") {
                const isQuotedBlock = /^ {0,3}(?:`{3,}|~{3,})/u.test(chunk.text);
                if (isQuotedBlock) {
                    items.push({
                        kind: "text",
                        content: chunk.text,
                        position: chunk.position,
                    });
                    continue;
                }
                const keptLines: string[] = [];
                const cLines = chunk.text.split("\n");
                for (let lIdx = 0; lIdx < cLines.length; lIdx += 1) {
                    const cLine = cLines[lIdx];
                    const markupMatch = /(<tool_call\b[^>]*>|<function=[A-Za-z0-9_.-]+>|<function_calls>|<invoke\b[^>]*>|\[TOOL_CALLS\]|<\|python_tag\|>|<\|tool_call[^>]*>)/u.exec(cLine);
                    if (markupMatch !== null) {
                        items.push({
                            kind: "error",
                            error: new PlurnkParseError(
                                chunk.position.line + lIdx,
                                0,
                                "parser",
                                `\`${markupMatch[1]}\` is tool-call markup and was not executed. Use \`await plurnk.<op>({ ... });\`.`,
                                "warning",
                                undefined,
                                true,
                            ),
                        });
                    }
                    const unfencedMatch = /^([A-Z]+)[ \t]*[(<[]/u.exec(cLine);
                    if (unfencedMatch !== null && isPlurnkOp(unfencedMatch[1])) {
                        items.push({
                            kind: "error",
                            error: new PlurnkParseError(
                                chunk.position.line + lIdx,
                                0,
                                "parser",
                                `Unfenced \`${unfencedMatch[1]}\` ignored.`,
                                "warning",
                                undefined,
                                true,
                            ),
                        });
                        continue;
                    }
                    keptLines.push(cLine);
                }
                const keptText = keptLines.join("\n").trim();
                if (keptText.length > 0) {
                    items.push({
                        kind: "text",
                        content: keptText,
                        position: chunk.position,
                    });
                }
            }
            continue;
        }

        activePosition = chunk.position;
        activeDefaultAside = chunk.defaultAside;
        activeChunkStatements = [];
        activeChunkAdvisories = [];

        const attempt: ParseAttempt = {
            verb: attemptVerbOf(chunk.text),
            text: chunk.text.trim(),
        };

        try {
            const calls = parseCallStatements(chunk.text, chunk.position);
            for (const call of calls) {
                dispatchCall(call);
            }
            for (const stmt of activeChunkStatements) {
                items.push({ kind: "statement", statement: stmt });
            }
            for (const adv of activeChunkAdvisories) {
                items.push({ kind: "error", error: adv });
            }
        } catch (err) {
            if (err instanceof PlurnkParseError) {
                const pos = err.line === 0 && err.column === 0 ? chunk.position : { line: err.line, column: err.column };
                const normalized = new PlurnkParseError(
                    pos.line,
                    pos.column,
                    err.source,
                    err.message,
                    err.severity,
                    err.recovery,
                    err.operationOmitted,
                );
                items.push({ kind: "error", error: normalized, attempt });
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                items.push({
                    kind: "error",
                    error: new PlurnkParseError(
                        chunk.position.line,
                        chunk.position.column,
                        "parser",
                        `Code Mode syntax error: ${msg}`,
                        "error",
                        "Write valid Code Mode calls such as `await plurnk.read({ path: \"file.txt\" });`.",
                    ),
                    attempt,
                });
            }
        }
    }

    return {
        items,
        ...(unparsedTail === undefined ? {} : { unparsedTail }),
    };
};

export { isPlurnkOp };
