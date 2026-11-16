import {
    PlurnkParseError,
    isRecord,
    type ParseAttempt,
    type ParseResult,
    type Position,
} from "@plurnk/plurnk-contracts";
import { parseCallStatements } from "./CallExpressionParser.ts";
import { BUILTIN_STANDALONE_EXECUTORS, propAccess, stringifyStatement, toMcpCall, type McpToolCallPayload } from "./ExpressionSerializer.ts";
import {
    CORE_OP_MAP,
    PLURNK_RUNTIME_TOOLS,
    buildExecutorSpellings,
} from "./OptionCoercion.ts";
import {
    attemptVerbOf,
    createCallDispatcher,
    type ParseOptions,
} from "./StatementLowering.ts";

export { stringifyStatement, toMcpCall, type McpToolCallPayload, type ParseOptions };

export interface LowerToolCallOptions extends ParseOptions {
    readonly aside?: string | null;
    readonly tier?: "model" | "statements";
    readonly position?: Position;
}

const OUTER_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
    "server",
    "tool",
    "function",
    "arguments",
    "args",
    "params",
    "aside",
]);

export const lowerToolCall = (
    service: string,
    tool: string,
    args?: unknown,
    options: LowerToolCallOptions = {},
): ParseResult => {
    const dispatcher = createCallDispatcher(options, options.tier ?? "statements");
    const position: Position = options.position ?? { line: 1, column: 0 };
    const callArgs = args === undefined ? [] : [args];
    const callText = `${service}${propAccess(tool)}(${args === undefined ? "" : JSON.stringify(args)})`;
    const attempt: ParseAttempt = {
        verb: attemptVerbOf(callText),
        text: callText,
    };
    const aside = typeof options.aside === "string" && options.aside.trim().length > 0
        ? options.aside.trim()
        : null;
    const items = dispatcher.lowerCalls(
        () => [{ chain: [service, tool], args: callArgs, position, ...(aside === null ? {} : { aside }) }],
        position,
        aside,
        attempt,
    );
    return { items };
};

const MCP_WORKING_FORM = 'mcp({ server: "plurnk", tool: "read", arguments: { path: "file.txt" } })';

const resolveImplicitTarget = (
    rawName: string,
    options: LowerToolCallOptions,
): { readonly server: string; readonly tool: string } | null => {
    const trimmed = rawName.trim();
    if (trimmed.length === 0) return null;
    const mcpPrefixed = /^mcp__([A-Za-z0-9_-]+)__(.+)$/u.exec(trimmed);
    if (mcpPrefixed !== null) {
        return { server: mcpPrefixed[1], tool: mcpPrefixed[2] };
    }
    const dotIdx = trimmed.indexOf(".");
    if (dotIdx > 0 && dotIdx < trimmed.length - 1) {
        return { server: trimmed.slice(0, dotIdx), tool: trimmed.slice(dotIdx + 1) };
    }
    const executorSpellings = buildExecutorSpellings(options.executors);
    const dblIdx = trimmed.indexOf("__");
    if (dblIdx > 0 && dblIdx < trimmed.length - 2) {
        const candidateServer = trimmed.slice(0, dblIdx);
        if (executorSpellings.has(candidateServer.toLowerCase())) {
            return { server: candidateServer, tool: trimmed.slice(dblIdx + 2) };
        }
    }
    const lower = trimmed.toLowerCase();
    const externalCollision = (options.executors ?? []).some((exec) => {
        const execLower = exec.toLowerCase();
        return execLower === lower && execLower !== "plurnk" && !BUILTIN_STANDALONE_EXECUTORS.has(execLower);
    });
    if (externalCollision) return null;
    const mappedExec = executorSpellings.get(lower);
    if (
        CORE_OP_MAP.has(lower)
        || PLURNK_RUNTIME_TOOLS.has(lower)
        || (mappedExec !== undefined && (mappedExec === "plurnk" || BUILTIN_STANDALONE_EXECUTORS.has(mappedExec)))
    ) {
        return { server: "plurnk", tool: trimmed };
    }
    return null;
};

const wireAttemptOf = (call: { readonly name: string; readonly arguments: unknown }): ParseAttempt => {
    const rawArgs = typeof call.arguments === "string"
        ? call.arguments
        : call.arguments === undefined
            ? ""
            : JSON.stringify(call.arguments);
    const text = `${call.name}(${rawArgs})`;
    return { verb: attemptVerbOf(text), text };
};

export const lowerMcpCall = (
    call: { readonly name: string; readonly arguments: unknown },
    options: LowerToolCallOptions = {},
): ParseResult => {
    const position: Position = options.position ?? { line: 1, column: 0 };
    const attempt = wireAttemptOf(call);
    let outer: unknown = call.arguments;
    if (typeof outer === "string") {
        const trimmed = outer.trim();
        if (trimmed.length === 0) {
            outer = {};
        } else {
            try {
                outer = JSON.parse(trimmed);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    items: [{
                        kind: "error",
                        attempt,
                        error: new PlurnkParseError(
                            position.line,
                            position.column,
                            "parser",
                            `Invalid JSON in \`${call.name}\` arguments: ${msg}`,
                            "error",
                            MCP_WORKING_FORM,
                            true,
                        ),
                    }],
                };
            }
        }
    }
    if (call.name !== "mcp") {
        const recovered = resolveImplicitTarget(call.name, options);
        if (recovered === null) {
            return {
                items: [{
                    kind: "error",
                    attempt,
                    error: new PlurnkParseError(
                        position.line,
                        position.column,
                        "parser",
                        `Unknown tool \`${call.name}\`; call \`mcp\` with \`{ server, tool, arguments }\`.`,
                        "error",
                        MCP_WORKING_FORM,
                        true,
                    ),
                }],
            };
        }
        const aside = isRecord(outer) && typeof outer.aside === "string" ? outer.aside : null;
        let directArgs: unknown = outer ?? {};
        if (isRecord(directArgs) && Object.hasOwn(directArgs, "aside")) {
            const copy = { ...directArgs };
            delete copy.aside;
            directArgs = copy;
        }
        const result = lowerToolCall(recovered.server, recovered.tool, directArgs, { ...options, tier: "model", aside, position });
        return {
            items: result.items.map((item) =>
                item.kind === "statement" ? { ...item, statement: { ...item.statement, position } } : item),
        };
    }
    if (!isRecord(outer)) {
        return {
            items: [{
                kind: "error",
                attempt,
                error: new PlurnkParseError(
                    position.line,
                    position.column,
                    "parser",
                    "`mcp` arguments must be a JSON object with `server`, `tool`, and `arguments`.",
                    "error",
                    MCP_WORKING_FORM,
                    true,
                ),
            }],
        };
    }
    let server = typeof outer.server === "string" ? outer.server.trim() : "";
    let tool = typeof outer.tool === "string"
        ? outer.tool.trim()
        : typeof outer.function === "string"
            ? outer.function.trim()
            : "";
    if (server.length === 0 && tool.length > 0) {
        const implicit = resolveImplicitTarget(tool, options);
        if (implicit !== null) {
            server = implicit.server;
            tool = implicit.tool;
        }
    }
    if (server.length === 0 || tool.length === 0) {
        return {
            items: [{
                kind: "error",
                attempt,
                error: new PlurnkParseError(
                    position.line,
                    position.column,
                    "parser",
                    "`mcp` requires non-empty `server` and `tool` strings.",
                    "error",
                    MCP_WORKING_FORM,
                    true,
                ),
            }],
        };
    }
    let innerArgs: unknown = outer.arguments ?? outer.args ?? outer.params;
    if (typeof innerArgs === "string") {
        const trimmedInner = innerArgs.trim();
        if (trimmedInner.startsWith("{") && trimmedInner.endsWith("}")) {
            try {
                innerArgs = JSON.parse(trimmedInner);
            } catch {
                // keep scalar string if non-JSON
            }
        }
    }
    const siblingEntries = Object.entries(outer).filter(([k, v]) => !OUTER_ENVELOPE_KEYS.has(k) && v !== undefined);
    if (siblingEntries.length > 0) {
        const merged: Record<string, unknown> = isRecord(innerArgs) ? { ...innerArgs } : {};
        for (const [k, v] of siblingEntries) {
            if (!Object.hasOwn(merged, k)) merged[k] = v;
        }
        innerArgs = merged;
    }
    const aside = typeof outer.aside === "string" ? outer.aside : null;
    const result = lowerToolCall(server, tool, innerArgs ?? {}, { ...options, tier: "model", aside, position });
    return {
        items: result.items.map((item) =>
            item.kind === "statement" ? { ...item, statement: { ...item.statement, position } } : item),
    };
};

export const parseStatements = (
    input: string,
    options: ParseOptions = {},
): ParseResult => {
    const trimmed = input.trim();
    if (trimmed.length === 0) return { items: [] };
    const dispatcher = createCallDispatcher(options, "statements");
    const position: Position = { line: 1, column: 0 };
    const attempt: ParseAttempt = {
        verb: attemptVerbOf(trimmed),
        text: trimmed,
    };
    const items = dispatcher.lowerCalls(
        () => parseCallStatements(input, position),
        position,
        null,
        attempt,
    );
    return { items };
};
