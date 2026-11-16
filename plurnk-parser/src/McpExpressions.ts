import {
    PlurnkParseError,
    isRecord,
    type ParseAttempt,
    type ParseResult,
    type Position,
} from "@plurnk/plurnk-contracts";
import { parseCallStatements } from "./CallExpressionParser.ts";
import { propAccess, stringifyStatement, toMcpCall, type McpToolCallPayload } from "./ExpressionSerializer.ts";
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

export const lowerMcpCall = (
    call: { readonly name: string; readonly arguments: unknown },
    options: LowerToolCallOptions = {},
): ParseResult => {
    const position: Position = options.position ?? { line: 1, column: 0 };
    if (call.name !== "mcp") {
        return {
            items: [{
                kind: "error",
                error: new PlurnkParseError(
                    position.line,
                    position.column,
                    "parser",
                    `Unknown tool \`${call.name}\`; call \`mcp\` with \`{ server, tool, arguments }\`.`,
                    "error",
                    'mcp({ server: "plurnk", tool: "read", arguments: { path: "file.txt" } })',
                ),
            }],
        };
    }
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
                        error: new PlurnkParseError(position.line, position.column, "parser", `Invalid JSON in \`mcp\` arguments: ${msg}`, "error"),
                    }],
                };
            }
        }
    }
    if (!isRecord(outer)) {
        return {
            items: [{
                kind: "error",
                error: new PlurnkParseError(position.line, position.column, "parser", "`mcp` arguments must be a JSON object with `server`, `tool`, and `arguments`.", "error"),
            }],
        };
    }
    const server = typeof outer.server === "string" ? outer.server.trim() : "";
    const tool = typeof outer.tool === "string"
        ? outer.tool.trim()
        : typeof outer.function === "string"
            ? outer.function.trim()
            : "";
    if (server.length === 0 || tool.length === 0) {
        return {
            items: [{
                kind: "error",
                error: new PlurnkParseError(position.line, position.column, "parser", "`mcp` requires non-empty `server` and `tool` strings.", "error"),
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
