import {
    isExecution,
    isRecord,
    type MatcherBody,
    type PlurnkStatement,
    type ResourceSelection,
} from "@plurnk/plurnk-contracts";
import { pickHeredocTag } from "./HeredocSyntax.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const escapeRegexSlashes = (pattern: string): string => {
    let out = "";
    let inClass = false;
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === "\\") {
            out += ch + (pattern[i + 1] ?? "");
            i += 1;
            continue;
        }
        if (ch === "[" && !inClass) inClass = true;
        else if (ch === "]" && inClass) inClass = false;
        else if (ch === "/" && !inClass) {
            out += "\\/";
            continue;
        }
        out += ch;
    }
    return out;
};

const formatMatcher = (matcher: MatcherBody): string =>
    matcher.dialect === "regex"
        ? `/${escapeRegexSlashes(matcher.pattern)}/${matcher.flags}`
        : matcher.raw;

export const BUILTIN_STANDALONE_EXECUTORS: ReadonlySet<string> = new Set([
    "sh",
    "js",
    "python3",
]);

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

const stringifyCodeModeValue = (value: unknown, key?: string): string => {
    if (typeof value === "string") {
        if ((key === "pattern" || value.includes("\n")) && !value.includes("\r")) {
            const tag = pickHeredocTag(value);
            return `<<<${tag}\n${value}\n${tag}`;
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stringifyCodeModeValue(item)).join(",")}]`;
    }
    if (isRecord(value)) {
        const entries = Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${JSON.stringify(k)}:${stringifyCodeModeValue(v, k)}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
};

const formatExecutionBodyArg = (body: string | null): string => {
    if (body === null || body === "") return "";
    if (isObjectLiteralString(body)) {
        const trimmed = body.trim();
        if (!trimmed.includes("\\n")) {
            return trimmed;
        }
        try {
            return stringifyCodeModeValue(JSON.parse(trimmed));
        } catch {
            return trimmed;
        }
    }
    return stringifyCodeModeValue(body);
};

export const stringifyStatement = (statement: PlurnkStatement): string => {
    if (isExecution(statement)) {
        const runtime = statement.runtime;
        if (
            runtime === "plurnk"
            && statement.target !== null
            && statement.lineMarker === null
        ) {
            const tool = spelledTarget(statement.target);
            const argStr = formatExecutionBodyArg(statement.body);
            return `await plurnk${propAccess(tool)}(${argStr})${formatAside(statement.aside)}`;
        }
        if (BUILTIN_STANDALONE_EXECUTORS.has(runtime) || statement.target === null) {
            if (
                !BUILTIN_STANDALONE_EXECUTORS.has(runtime)
                && statement.target === null
                && statement.lineMarker === null
            ) {
                const argStr = formatExecutionBodyArg(statement.body);
                return `await plurnk${propAccess(runtime)}(${argStr})${formatAside(statement.aside)}`;
            }
            const args: Record<string, unknown> = {};
            if (statement.cwd !== undefined && statement.cwd !== null) {
                if (statement.target !== null) args.script = spelledTarget(statement.target);
                args.cwd = statement.cwd;
            } else if (statement.target !== null) {
                args[BUILTIN_STANDALONE_EXECUTORS.has(runtime) ? "cwd" : "target"] = spelledTarget(statement.target);
            }
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.body !== null && statement.body.length > 0) {
                const bodyKey = BUILTIN_STANDALONE_EXECUTORS.has(runtime) ? "text" : "body";
                args[bodyKey] = statement.body;
            }
            return `await plurnk${propAccess(runtime)}(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        const tool = spelledTarget(statement.target);
        let argStr = formatExecutionBodyArg(statement.body);
        if (statement.lineMarker !== null) {
            const opts: Record<string, unknown> = { range: formatRange(statement.lineMarker) };
            argStr = `${argStr === "" ? "null" : argStr}, ${stringifyCodeModeValue(opts)}`;
        }
        return `await ${runtime}${propAccess(tool)}(${argStr})${formatAside(statement.aside)}`;
    }

    switch (statement.op) {
        case "read":
        case "find": {
            const method = statement.op;
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.path = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.matcher !== null) args.pattern = formatMatcher(statement.matcher);
            if (statement.headers !== null) args.headers = statement.headers;
            return `await plurnk.${method}(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        case "edit": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.path = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.matcher !== null) args.pattern = formatMatcher(statement.matcher);
            if (statement.headers !== null) args.headers = statement.headers;
            if (statement.body !== null && statement.body.length > 0) args.text = statement.body;
            return `await plurnk.edit(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        case "copy":
        case "move": {
            const method = statement.op;
            const formatSel = (sel: ResourceSelection): unknown => {
                if (sel.lineMarker === null && sel.matcher === null && sel.headers === null) {
                    return spelledTarget(sel.target);
                }
                const obj: Record<string, unknown> = { path: spelledTarget(sel.target) };
                if (sel.lineMarker !== null) obj.range = formatRange(sel.lineMarker);
                if (sel.matcher !== null) obj.pattern = formatMatcher(sel.matcher);
                if (sel.headers !== null) obj.headers = sel.headers;
                return obj;
            };
            const args = { from: formatSel(statement.source), to: formatSel(statement.destination) };
            return `await plurnk.${method}(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        case "kill": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.path = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.matcher !== null) args.pattern = formatMatcher(statement.matcher);
            if (statement.remote !== null) args.remote = statement.remote;
            if (statement.headers !== null) args.headers = statement.headers;
            if (statement.body !== null && statement.body.length > 0) args.note = statement.body;
            return `await plurnk.kill(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        case "note": {
            const args: Record<string, unknown> = {};
            if (statement.body !== null && statement.body.length > 0) args.text = statement.body;
            return `await plurnk.note(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        case "todo": {
            if (statement.body === "Resolve all Open Work.") {
                return `await plurnk.todo({"items":[<<<EOF\nResolve all Open Work.\nEOF]})${formatAside(statement.aside)}`;
            }
            const args: Record<string, unknown> = {};
            if (statement.body !== null && statement.body.length > 0) args.items = statement.body.split(/\r?\n/gu);
            return `await plurnk.todo(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        case "work":
        case "fork":
        case "bare": {
            const method = statement.op;
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            args.text = statement.body;
            return `await plurnk.${method}(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        case "send": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            if (statement.headers !== null) args.headers = statement.headers;
            if (statement.attachments !== null) args.attachments = statement.attachments;
            if (statement.body !== null && statement.body.raw.length > 0) args.text = statement.body.raw;
            return `await plurnk.send(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        case "done":
        case "fail": {
            const method = statement.op;
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            if (statement.attachments !== null) args.attachments = statement.attachments;
            if (statement.body !== null && statement.body.raw.length > 0) args.text = statement.body.raw;
            return `await plurnk.${method}(${stringifyCodeModeValue(args)})${formatAside(statement.aside)}`;
        }
        case "wait": {
            const args: Record<string, unknown> = {};
            if (statement.seconds !== null) args.seconds = statement.seconds;
            const aside = statement.aside ?? (statement.body !== null && statement.body.length > 0 ? statement.body : null);
            return `await plurnk.wait(${stringifyCodeModeValue(args)})${formatAside(aside)}`;
        }
    }
};
