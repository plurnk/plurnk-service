import {
    INTERNAL_ROW_OPS,
    PlurnkParseError,
    isExecutionOp,
    isRecord,
    type ParseAttempt,
    type ParseItem,
    type PlurnkStatement,
    type Position,
    type RuntimeTag,
} from "@plurnk/plurnk-contracts";
import { BUILTIN_STANDALONE_EXECUTORS } from "./ExpressionSerializer.ts";
import type { LoweringContext } from "./lower/context.ts";
import { buildEdit, buildKill, buildReadOrFind, buildTransfer } from "./lower/data-verbs.ts";
import { buildMcpCall, buildPlurnkTool, buildStandaloneExec } from "./lower/execution-calls.ts";
import {
    buildConclusion,
    buildDelegation,
    buildNote,
    buildSend,
    buildWait,
} from "./lower/session-and-control.ts";
import {
    COMMENTARY_ASIDE_KEYS,
    CORE_OP_MAP,
    PLURNK_RUNTIME_TOOLS,
    assertAllowedKeys,
    attemptVerbOf,
    buildExecutorSpellings,
    isBareScriptFilename,
    toMatcherBody,
    toStringValue,
    type ParseOptions,
    type ParsedCall,
} from "./OptionCoercion.ts";

export { attemptVerbOf, type ParseOptions };

export interface CallDispatcher {
    readonly executorSpellings: ReadonlyMap<string, RuntimeTag>;
    readonly lowerCalls: (
        produceCalls: () => readonly ParsedCall[],
        chunkPosition: Position,
        defaultAside: string | null,
        attempt: ParseAttempt,
    ) => ParseItem[];
}

export const createCallDispatcher = (
    options: ParseOptions = {},
    tier: "model" | "statements" = "model",
): CallDispatcher => {
    const hasExplicitExecutors = options.executors !== undefined;
    const executorSpellings = buildExecutorSpellings(options.executors);

    let activePosition: Position = { line: 1, column: 0 };
    let activeDefaultAside: string | null = null;
    let activeChunkStatements: PlurnkStatement[] = [];
    let unwrappingNestedMcp = false;

    const ctx: LoweringContext = {
        tier,
        options,
        executorSpellings,
        position: () => activePosition,
        defaultAside: () => activeDefaultAside,
        emitStatement: <T extends PlurnkStatement>(statement: T): T => {
            const withAside: T = statement.aside === null && activeDefaultAside !== null
                ? { ...statement, aside: activeDefaultAside }
                : statement;
            activeChunkStatements.push(withAside);
            return withAside;
        },
        checkKeys: (obj, allowed, opLabel, recovery, pos) => {
            assertAllowedKeys(obj, allowed, opLabel, recovery, pos, tier === "model", activeDefaultAside !== null);
        },
        resolveAside: (argObj) => {
            if (argObj !== null && typeof argObj.aside === "string" && argObj.aside.trim().length > 0) {
                return argObj.aside.trim();
            }
            if (activeDefaultAside !== null) return activeDefaultAside;
            if (argObj !== null && tier === "model") {
                for (const key of COMMENTARY_ASIDE_KEYS) {
                    const val = argObj[key];
                    if (typeof val === "string" && val.trim().length > 0) {
                        return val.trim();
                    }
                }
            }
            return null;
        },
        resolveMatcher: (value, op, pos) => toMatcherBody(value, op, pos),
        coerceBodyString: (value) => toStringValue(value),
        coerceArgString: (args, index) => toStringValue(args[index]),
    };

    const dispatchPlurnkTool = (prop: string, args: readonly unknown[]): void => {
        const lower = prop.toLowerCase();
        const explicitSingleExecutor = options.executors?.length === 1 && options.executors[0]?.toLowerCase() === lower;
        const coreOp = explicitSingleExecutor ? undefined : CORE_OP_MAP.get(lower);
        if (coreOp !== undefined) {
            switch (coreOp) {
                case "read":
                case "find":
                    buildReadOrFind(ctx, coreOp, args);
                    return;
                case "edit":
                    buildEdit(ctx, args);
                    return;
                case "copy":
                case "move":
                    buildTransfer(ctx, coreOp, args);
                    return;
                case "kill":
                    buildKill(ctx, args);
                    return;
                case "note":
                    buildNote(ctx, args);
                    return;
                case "work":
                case "fork":
                case "bare":
                    buildDelegation(ctx, coreOp, args);
                    return;
                case "send":
                    buildSend(ctx, args);
                    return;
                case "done":
                case "fail":
                    buildConclusion(ctx, coreOp, args);
                    return;
                case "wait":
                    buildWait(ctx, args);
                    return;
            }
        }
        if (tier === "model" && !explicitSingleExecutor && lower === "write") {
            buildEdit(ctx, args, true);
            return;
        }
        if (
            tier === "model"
            && !unwrappingNestedMcp
            && lower === "mcp"
            && isRecord(args[0])
        ) {
            const first = args[0];
            const nestedServer = typeof first.server === "string"
                ? first.server.trim()
                : typeof first.name === "string"
                    ? first.name.trim()
                    : typeof first.alias === "string"
                        ? first.alias.trim()
                        : "";
            const nestedTool = typeof first.tool === "string"
                ? first.tool.trim()
                : typeof first.function === "string"
                    ? first.function.trim()
                    : "";
            const hasMcpConfigKey = [
                "type", "command", "url", "authorization", "plurnkWorkspace",
                "plurnkSession", "enabled", "remove", "discover", "scope",
            ].some((key) => first[key] !== undefined);
            if (nestedServer.length > 0 && nestedTool.length > 0 && !hasMcpConfigKey) {
                const nestedAside = typeof first.aside === "string" && first.aside.trim().length > 0
                    ? first.aside.trim()
                    : null;
                const hasEnvelopeArgs = first.arguments === undefined
                    && (isRecord(first.args) || (typeof first.args === "string" && first.args.trim().startsWith("{")));
                let nestedArgs: unknown = first.arguments ?? (hasEnvelopeArgs ? first.args : undefined) ?? first.params;
                if (typeof nestedArgs === "string") {
                    const trimmedInner = nestedArgs.trim();
                    if (trimmedInner.startsWith("{") && trimmedInner.endsWith("}")) {
                        try {
                            nestedArgs = JSON.parse(trimmedInner);
                        } catch {
                            // keep scalar string if non-JSON
                        }
                    }
                }
                const envelopeKeys = new Set([
                    "server", "name", "alias", "tool", "function",
                    "arguments", "params", "aside",
                    ...(hasEnvelopeArgs ? ["args"] : []),
                ]);
                const extraEntries = Object.entries(first).filter(([k, v]) => !envelopeKeys.has(k) && v !== undefined);
                if (extraEntries.length > 0) {
                    const merged: Record<string, unknown> = isRecord(nestedArgs) ? { ...nestedArgs } : {};
                    for (const [k, v] of extraEntries) {
                        if (!Object.hasOwn(merged, k)) merged[k] = v;
                    }
                    nestedArgs = merged;
                }
                const prevAside = activeDefaultAside;
                if (prevAside === null && nestedAside !== null) activeDefaultAside = nestedAside;
                unwrappingNestedMcp = true;
                try {
                    dispatchCall({ chain: [nestedServer, nestedTool], args: [nestedArgs ?? {}], position: activePosition });
                } finally {
                    unwrappingNestedMcp = false;
                    activeDefaultAside = prevAside;
                }
                return;
            }
        }
        if (PLURNK_RUNTIME_TOOLS.has(lower) || (lower.includes("|") && lower.split("|").every((part) => PLURNK_RUNTIME_TOOLS.has(part)))) {
            buildPlurnkTool(ctx, lower, args);
            return;
        }
        if (lower === "plurnk") {
            if (typeof args[0] === "string" && args.length > 1) {
                buildPlurnkTool(ctx, args[0], args.slice(1));
                return;
            }
            if (isRecord(args[0])) {
                throw new PlurnkParseError(
                    activePosition.line,
                    activePosition.column,
                    "parser",
                    "Missing tool name on `plurnk`.",
                    "error",
                    "Use a `plurnk` tool (`read`, `edit`, `note`, ...; see `mcp:///plurnk.md`).",
                );
            }
            buildStandaloneExec(ctx, "plurnk", args);
            return;
        }
        const knownRuntime = executorSpellings.get(lower);
        if (knownRuntime !== undefined) {
            buildStandaloneExec(ctx, knownRuntime, args);
            return;
        }
        const hasPlurnkRuntime = options.executors?.some((executor) => executor.toLowerCase() === "plurnk") === true;
        if (hasPlurnkRuntime && !INTERNAL_ROW_OPS.has(lower)) {
            buildPlurnkTool(ctx, prop, args);
            return;
        }
        if (isExecutionOp(prop) && args.length > 0) {
            buildStandaloneExec(ctx, prop, args);
            return;
        }
        throw new PlurnkParseError(
            activePosition.line,
            activePosition.column,
            "parser",
            `Unknown tool \`plurnk.${prop}\`.`,
            "error",
            "Use a `plurnk` tool (`mcp:///plurnk.md`) or another MCP server (`mcp:///*.md`).",
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
                    buildPlurnkTool(ctx, args[0], args.slice(1));
                    return;
                }
                buildStandaloneExec(ctx, "plurnk", args);
                return;
            }
            const knownRuntime = executorSpellings.get(lower);
            if (knownRuntime !== undefined) {
                buildStandaloneExec(ctx, knownRuntime, args);
                return;
            }
            if (tier === "model" && (CORE_OP_MAP.has(lower) || PLURNK_RUNTIME_TOOLS.has(lower) || lower === "write")) {
                dispatchPlurnkTool(lower, args);
                return;
            }
            if (!hasExplicitExecutors && isExecutionOp(head)) {
                buildStandaloneExec(ctx, head, args);
                return;
            }
            throw new PlurnkParseError(
                call.position.line,
                call.position.column,
                "parser",
                `Unknown tool \`${head}\`.`,
                "error",
                'Call `mcp` with `{ server: "plurnk", tool: "<tool>", arguments: { ... } }`.',
            );
        }
        if (chain.length === 2) {
            const [service = "", tool = ""] = chain;
            if (service === "plurnk") {
                dispatchPlurnkTool(tool, args);
                return;
            }
            const knownRuntime = executorSpellings.get(service.toLowerCase());
            if (knownRuntime !== undefined && BUILTIN_STANDALONE_EXECUTORS.has(knownRuntime)) {
                if ((tool.includes("/") || isBareScriptFilename(knownRuntime, tool)) && isRecord(args[0]) && !Object.hasOwn(args[0], "script")) {
                    buildStandaloneExec(ctx, knownRuntime, [{ ...args[0], script: tool }, ...args.slice(1)]);
                    return;
                }
                buildStandaloneExec(ctx, knownRuntime, args);
                return;
            }
            buildMcpCall(ctx, service, tool, args);
            return;
        }
        if (chain.length === 3 && chain[0]?.toLowerCase() === "plurnk") {
            const [, service = "", tool = ""] = chain;
            buildMcpCall(ctx, service, tool, args);
            return;
        }
        throw new PlurnkParseError(
            call.position.line,
            call.position.column,
            "parser",
            `Invalid call target \`${chain.join(".")}\`.`,
            "error",
            'Call `mcp` with `{ server: "<server>", tool: "<tool>", arguments: { ... } }`.',
        );
    };

    const lowerCalls = (
        produceCalls: () => readonly ParsedCall[],
        chunkPosition: Position,
        defaultAside: string | null,
        attempt: ParseAttempt,
    ): ParseItem[] => {
        activePosition = chunkPosition;
        activeDefaultAside = defaultAside;
        activeChunkStatements = [];
        const items: ParseItem[] = [];
        try {
            const calls = produceCalls();
            for (const call of calls) {
                activeDefaultAside = call.aside ?? defaultAside;
                dispatchCall(call);
            }
            for (const stmt of activeChunkStatements) {
                items.push({ kind: "statement", statement: stmt });
            }
        } catch (err) {
            const fallbackRecovery = 'Call `mcp` with `{ server: "plurnk", tool: "read", arguments: { path: "file.txt" } }`.';
            if (err instanceof PlurnkParseError) {
                const pos = err.line === 0 && err.column === 0 ? chunkPosition : { line: err.line, column: err.column };
                const normalized = new PlurnkParseError(
                    pos.line,
                    pos.column,
                    err.source,
                    err.message,
                    err.severity,
                    err.severity === "error" ? (err.recovery ?? fallbackRecovery) : err.recovery,
                    err.operationOmitted,
                );
                items.push({ kind: "error", error: normalized, attempt });
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                items.push({
                    kind: "error",
                    error: new PlurnkParseError(
                        chunkPosition.line,
                        chunkPosition.column,
                        "parser",
                        `Tool call error: ${msg}`,
                        "error",
                        fallbackRecovery,
                    ),
                    attempt,
                });
            }
        }
        return items;
    };

    return {
        executorSpellings,
        lowerCalls,
    };
};
