import {
    isExecution,
    isRecord,
    type MatcherBody,
    type PlurnkStatement,
    type ResourceSelection,
} from "@plurnk/plurnk-contracts";

export interface McpToolCallPayload {
    readonly server: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
    readonly aside?: string;
}

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

const cleanAside = (aside: string | null): string | undefined =>
    aside === null || aside.length === 0 ? undefined : aside.replaceAll(/\r?\n/gu, " ");

const parseBodyObject = (body: string | null): Record<string, unknown> => {
    if (body === null || body.length === 0) return {};
    try {
        const parsed: unknown = JSON.parse(body);
        if (isRecord(parsed)) return { ...parsed };
    } catch {
        // non-JSON scalar body
    }
    return { text: body };
};

// {§parser-lowering} Canonical projection from PlurnkStatement AST nodes to McpToolCallPayload and statement source.
export const toMcpCall = (statement: PlurnkStatement): McpToolCallPayload => {
    if (isExecution(statement)) {
        const runtime = statement.runtime;
        const aside = cleanAside(statement.aside);
        if (runtime === "plurnk" && statement.target !== null) {
            const args = parseBodyObject(statement.body);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            return {
                server: "plurnk",
                tool: spelledTarget(statement.target),
                arguments: args,
                ...(aside === undefined ? {} : { aside }),
            };
        }
        if (BUILTIN_STANDALONE_EXECUTORS.has(runtime) || statement.target === null) {
            const args: Record<string, unknown> = {};
            if (statement.cwd !== undefined && statement.cwd !== null) {
                if (statement.target !== null) args.script = spelledTarget(statement.target);
                args.cwd = statement.cwd;
            } else if (statement.target !== null) {
                const raw = spelledTarget(statement.target);
                const targetKey = BUILTIN_STANDALONE_EXECUTORS.has(runtime)
                    ? (
                        statement.body === null
                        || statement.body.length === 0
                        || /^[a-z][a-z0-9+._-]*:\/\//iu.test(raw)
                        || /\.(?:m?js|cjs|m?ts|cts|py|sh|bash|zsh)$/iu.test(raw)
                            ? "script"
                            : "cwd"
                    )
                    : "target";
                args[targetKey] = raw;
            }
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.body !== null && statement.body.length > 0) {
                args[BUILTIN_STANDALONE_EXECUTORS.has(runtime) ? "text" : "body"] = statement.body;
            }
            if (statement.env !== undefined && Object.keys(statement.env).length > 0) {
                args.env = statement.env;
            }
            return {
                server: "plurnk",
                tool: runtime,
                arguments: args,
                ...(aside === undefined ? {} : { aside }),
            };
        }
        const args = parseBodyObject(statement.body);
        if (statement.lineMarker !== null && !Object.hasOwn(args, "range")) {
            args.range = formatRange(statement.lineMarker);
        }
        return {
            server: runtime,
            tool: spelledTarget(statement.target),
            arguments: args,
            ...(aside === undefined ? {} : { aside }),
        };
    }

    switch (statement.op) {
        case "read":
        case "find": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.path = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.matcher !== null) args.pattern = formatMatcher(statement.matcher);
            if (statement.headers !== null) args.headers = statement.headers;
            const aside = cleanAside(statement.aside);
            return { server: "plurnk", tool: statement.op, arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
        case "edit": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.path = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.matcher !== null) args.pattern = formatMatcher(statement.matcher);
            if (statement.headers !== null) args.headers = statement.headers;
            if (statement.body !== null && statement.body.length > 0) args.text = statement.body;
            const aside = cleanAside(statement.aside);
            return { server: "plurnk", tool: "edit", arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
        case "copy":
        case "move": {
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
            const aside = cleanAside(statement.aside);
            return { server: "plurnk", tool: statement.op, arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
        case "kill": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.path = spelledTarget(statement.target);
            if (statement.lineMarker !== null) args.range = formatRange(statement.lineMarker);
            if (statement.matcher !== null) args.pattern = formatMatcher(statement.matcher);
            if (statement.remote !== null) args.remote = statement.remote;
            if (statement.headers !== null) args.headers = statement.headers;
            const aside = cleanAside(statement.aside);
            return { server: "plurnk", tool: "kill", arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
        case "note": {
            const args: Record<string, unknown> = {};
            if (statement.body !== null && statement.body.length > 0) args.text = statement.body;
            const aside = cleanAside(statement.aside);
            return { server: "plurnk", tool: "note", arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
        case "work":
        case "fork": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            args.text = statement.body;
            if (statement.persona !== undefined) args.persona = statement.persona;
            if (statement.model !== undefined) args.model = statement.model;
            if (statement.effort !== undefined) args.effort = statement.effort;
            const aside = cleanAside(statement.aside);
            return { server: "plurnk", tool: statement.op, arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
        case "bare": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            args.text = statement.body;
            const aside = cleanAside(statement.aside);
            return { server: "plurnk", tool: statement.op, arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
        case "send": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            if (statement.headers !== null) args.headers = statement.headers;
            if (statement.attachments !== null) args.attachments = statement.attachments;
            if (statement.body !== null && statement.body.raw.length > 0) args.text = statement.body.raw;
            const aside = cleanAside(statement.aside);
            return { server: "plurnk", tool: "send", arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
        case "done":
        case "fail": {
            const args: Record<string, unknown> = {};
            if (statement.target !== null) args.target = spelledTarget(statement.target);
            if (statement.attachments !== null) args.attachments = statement.attachments;
            if (statement.body !== null && statement.body.raw.length > 0) args.text = statement.body.raw;
            const aside = cleanAside(statement.aside);
            return { server: "plurnk", tool: statement.op, arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
        case "wait": {
            const args: Record<string, unknown> = {};
            if (statement.seconds !== null) args.seconds = statement.seconds;
            const aside = cleanAside(statement.aside ?? (statement.body !== null && statement.body.length > 0 ? statement.body : null));
            return { server: "plurnk", tool: "wait", arguments: args, ...(aside === undefined ? {} : { aside }) };
        }
    }
};

const stringifyExpressionValue = (value: unknown): string => {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stringifyExpressionValue(item)).join(",")}]`;
    }
    if (isRecord(value)) {
        const entries = Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${JSON.stringify(k)}:${stringifyExpressionValue(v)}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
};

const formatBodyArg = (body: string | null): string => {
    if (body === null || body === "") return "";
    const trimmed = body.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
            return stringifyExpressionValue(JSON.parse(trimmed));
        } catch {
            return JSON.stringify(body);
        }
    }
    return JSON.stringify(body);
};

export const stringifyStatement = (statement: PlurnkStatement): string => {
    if (isExecution(statement)) {
        const runtime = statement.runtime;
        if (runtime === "plurnk" && statement.target !== null && statement.lineMarker === null) {
            const tool = spelledTarget(statement.target);
            return `plurnk${propAccess(tool)}(${formatBodyArg(statement.body)})${formatAside(statement.aside)}`;
        }
        if (
            !BUILTIN_STANDALONE_EXECUTORS.has(runtime)
            && statement.target === null
            && statement.lineMarker === null
            && (statement.cwd === undefined || statement.cwd === null)
            && statement.env === undefined
        ) {
            return `plurnk${propAccess(runtime)}(${formatBodyArg(statement.body)})${formatAside(statement.aside)}`;
        }
        if (!BUILTIN_STANDALONE_EXECUTORS.has(runtime) && statement.target !== null) {
            const tool = spelledTarget(statement.target);
            let argStr = formatBodyArg(statement.body);
            if (statement.lineMarker !== null) {
                const opts = { range: formatRange(statement.lineMarker) };
                argStr = `${argStr === "" ? "null" : argStr}, ${stringifyExpressionValue(opts)}`;
            }
            return `${runtime}${propAccess(tool)}(${argStr})${formatAside(statement.aside)}`;
        }
    }
    const call = toMcpCall(statement);
    return `${call.server}${propAccess(call.tool)}(${stringifyExpressionValue(call.arguments)})${call.aside === undefined ? "" : formatAside(call.aside)}`;
};
