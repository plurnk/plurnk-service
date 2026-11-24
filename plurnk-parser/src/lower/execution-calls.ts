import {
    PlurnkParseError,
    isExecutionOp,
    isRecord,
    type ExecStatement,
    type RuntimeTag,
} from "@plurnk/plurnk-contracts";
import { BUILTIN_STANDALONE_EXECUTORS } from "../ExpressionSerializer.ts";
import {
    BUILTIN_EXEC_KEYS,
    CALL_OPTIONS_KEYS,
    isBareScriptFilename,
    toLineMarker,
    toStringValue,
} from "../OptionCoercion.ts";
import { parsePath } from "../TargetSyntax.ts";
import type { LoweringContext } from "./context.ts";

const normalizePlurnkToolObject = (toolName: string, input: Record<string, unknown>): Record<string, unknown> => {
    const keyMap: Record<string, string> = {};
    if (toolName === "members") {
        for (const k of ["paths", "files", "file", "glob", "name", "alias"]) keyMap[k] = "path";
    } else if (toolName === "question") {
        for (const k of ["message", "question", "prompt", "content", "body"]) keyMap[k] = "text";
        keyMap.choices = "options";
        keyMap.multiSelect = "multi";
        keyMap.is_multi_select = "multi";
        keyMap.requestedSchema = "schema";
    } else if (toolName === "env" || toolName === "mcp" || toolName === "personas" || toolName === "schedule" || toolName === "skills") {
        for (const k of ["alias", "key", "server", "id"]) keyMap[k] = "name";
        if (toolName === "env") {
            keyMap.environment = "env";
        } else if (toolName === "personas") {
            keyMap.text = "body";
            keyMap.instructions = "body";
        } else if (toolName === "schedule") {
            keyMap.text = "prompt";
            keyMap.message = "prompt";
        } else if (toolName === "skills") {
            keyMap.path = "source";
            keyMap.file = "source";
            keyMap.dir = "source";
        }
    } else {
        return input;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
        if (v === undefined) continue;
        const mapped = keyMap[k];
        if (mapped !== undefined && !Object.hasOwn(input, mapped) && !Object.hasOwn(out, mapped)) {
            out[mapped] = v;
        } else {
            out[k] = v;
        }
    }
    return out;
};

export const buildPlurnkTool = (
    ctx: LoweringContext,
    rawToolName: string,
    args: readonly unknown[],
): ExecStatement => {
    const pos = ctx.position();
    const toolName = rawToolName === "environment" ? "env" : rawToolName;
    const target = parsePath(toolName, pos);
    const first = args[0];
    const second = isRecord(args[1]) ? args[1] : null;
    if (second !== null) {
        ctx.checkKeys(
            second,
            CALL_OPTIONS_KEYS,
            `plurnk.${toolName}`,
            `mcp({ server: "plurnk", tool: ${JSON.stringify(toolName)}, arguments: { ... } })`,
            pos,
        );
    }
    let body: string | null = null;
    if (first !== undefined && first !== null && first !== "") {
        if (isRecord(first)) {
            body = JSON.stringify(normalizePlurnkToolObject(toolName, first));
        } else {
            body = typeof first === "string" ? first : JSON.stringify(first);
        }
    }
    return ctx.emitStatement({
        runtime: "plurnk",
        aside: ctx.resolveAside(second),
        target,
        lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.line ?? second?.scope, pos),
        body,
        position: pos,
    });
};

export const buildStandaloneExec = (
    ctx: LoweringContext,
    runtime: RuntimeTag,
    args: readonly unknown[],
): ExecStatement => {
    const pos = ctx.position();
    const defaultAside = ctx.defaultAside();
    const isBuiltinExec = BUILTIN_STANDALONE_EXECUTORS.has(runtime);
    const recovery = `mcp({ server: "plurnk", tool: "${runtime}", arguments: { text: "..." } })`;
    if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
        return ctx.emitStatement({
            runtime,
            aside: defaultAside,
            target: null,
            lineMarker: null,
            body: null,
            position: pos,
        });
    }
    if (typeof args[0] === "string" && args.length >= 2) {
        const target = parsePath(args[0], pos);
        const second = args[1];
        const body = second === null || second === undefined || second === "" ? null : (typeof second === "string" ? second : JSON.stringify(second));
        const third = isRecord(args[2]) ? args[2] : null;
        if (third !== null) {
            ctx.checkKeys(third, CALL_OPTIONS_KEYS, `plurnk.${runtime}`, recovery, pos);
        }
        return ctx.emitStatement({
            runtime,
            aside: ctx.resolveAside(third),
            target,
            lineMarker: toLineMarker(third?.range ?? third?.lines ?? third?.line ?? third?.scope, pos),
            body,
            position: pos,
        });
    }
    if (typeof args[0] === "string") {
        return ctx.emitStatement({
            runtime,
            aside: defaultAside,
            target: null,
            lineMarker: null,
            body: args[0],
            position: pos,
        });
    }
    if (isRecord(args[0])) {
        const first = args[0];
        if (isBuiltinExec) {
            ctx.checkKeys(first, BUILTIN_EXEC_KEYS, `plurnk.${runtime}`, recovery, pos);
        }
        const hasEnvelopeKey = Object.keys(first).some((k) => BUILTIN_EXEC_KEYS.has(k));
        if (!hasEnvelopeKey && !isBuiltinExec) {
            const second = isRecord(args[1]) ? args[1] : null;
            if (second !== null) {
                ctx.checkKeys(second, CALL_OPTIONS_KEYS, `plurnk.${runtime}`, recovery, pos);
            }
            return ctx.emitStatement({
                runtime,
                aside: ctx.resolveAside(second),
                target: null,
                lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.line ?? second?.scope, pos),
                body: Object.keys(first).length === 0 ? null : JSON.stringify(first),
                position: pos,
            });
        }
        const explicitBody = first.text ?? first.code ?? first.command ?? first.cmd ?? first.body ?? first.source ?? first.prompt;
        const inlineScriptBody = explicitBody === undefined
            && typeof first.script === "string"
            && /[\s;()"'|&<>]/u.test(first.script.trim())
            ? first.script
            : undefined;
        const explicitScript = (inlineScriptBody === undefined ? first.script : undefined) ?? first.target ?? first.path ?? first.file;
        const initialBody = explicitBody ?? inlineScriptBody;
        const promoteBodyToScript = explicitScript === undefined && isBareScriptFilename(runtime, initialBody);
        const rawScript = promoteBodyToScript ? initialBody : explicitScript;
        const rawCwd = first.cwd;
        const hasBothCwdAndScript = typeof rawCwd === "string" && rawCwd.length > 0
            && typeof rawScript === "string" && rawScript.length > 0;
        const rawTarget = hasBothCwdAndScript ? rawScript : (rawCwd ?? rawScript);
        const target = typeof rawTarget === "string" && rawTarget.length > 0 ? parsePath(rawTarget, pos) : null;
        const cwd = hasBothCwdAndScript ? rawCwd : undefined;
        const lineMarker = toLineMarker(first.range ?? first.lines ?? first.line ?? first.scope, pos);
        let body: string | null = null;
        const rawBody = promoteBodyToScript ? undefined : initialBody;
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
        let env: Record<string, string> | undefined;
        if (first.env !== undefined && first.env !== null) {
            if (!isRecord(first.env)) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", "`env` must be an object of environment variables.", "error", recovery);
            }
            const envPairs: Array<readonly [string, string]> = [];
            for (const [envKey, envVal] of Object.entries(first.env)) {
                if (envVal === undefined || envVal === null) continue;
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envKey) || (typeof envVal !== "string" && typeof envVal !== "number" && typeof envVal !== "boolean")) {
                    throw new PlurnkParseError(pos.line, pos.column, "visitor", `Invalid \`env\` entry ${JSON.stringify(envKey)} on \`plurnk.${runtime}\`.`, "error", recovery);
                }
                envPairs.push([envKey, String(envVal)]);
            }
            if (envPairs.length > 0) {
                env = Object.fromEntries(envPairs);
            }
        }
        return ctx.emitStatement({
            runtime,
            aside: ctx.resolveAside(first),
            target,
            ...(cwd === undefined ? {} : { cwd }),
            ...(env === undefined ? {} : { env }),
            lineMarker,
            body,
            position: pos,
        });
    }
    return ctx.emitStatement({
        runtime,
        aside: defaultAside,
        target: null,
        lineMarker: null,
        body: JSON.stringify(args[0]),
        position: pos,
    });
};

export const buildMcpCall = (
    ctx: LoweringContext,
    rawServer: string,
    rawTool: string,
    args: readonly unknown[],
): ExecStatement => {
    const pos = ctx.position();
    const lowerServer = rawServer.toLowerCase();
    if (!isExecutionOp(lowerServer)) {
        throw new PlurnkParseError(
            pos.line,
            pos.column,
            "parser",
            `Invalid MCP runtime name ${JSON.stringify(rawServer)}.`,
            "error",
            "Use a `plurnk` tool (`mcp:///plurnk.md`) or another MCP server (`mcp:///*.md`).",
        );
    }
    if (rawServer !== lowerServer && !ctx.executorSpellings.has(lowerServer)) {
        throw new PlurnkParseError(
            pos.line,
            pos.column,
            "parser",
            `Unknown runtime ${JSON.stringify(rawServer)}; runtime names are lowercase.`,
            "error",
            `mcp({ server: ${JSON.stringify(lowerServer)}, tool: ${JSON.stringify(rawTool)}, arguments: {} })`,
        );
    }
    const runtime = lowerServer;
    const target = parsePath(rawTool, pos);
    const first = args[0];
    const second = isRecord(args[1]) ? args[1] : null;
    if (second !== null) {
        ctx.checkKeys(
            second,
            CALL_OPTIONS_KEYS,
            `${runtime}.${rawTool}`,
            `mcp({ server: ${JSON.stringify(runtime)}, tool: ${JSON.stringify(rawTool)}, arguments: { ... } })`,
            pos,
        );
    }
    let body: string | null = null;
    if (first !== undefined && first !== null && first !== "") {
        body = typeof first === "string" ? first : JSON.stringify(first);
    }
    return ctx.emitStatement({
        runtime,
        aside: ctx.resolveAside(second),
        target,
        lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.line ?? second?.scope, pos),
        body,
        position: pos,
    });
};
