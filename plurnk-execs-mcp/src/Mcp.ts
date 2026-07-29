import type { Client } from "@modelcontextprotocol/client";
import { BaseExecutor, ErrorDetail, ERROR_DETAIL_LIMIT, Results } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, RuntimeDecl, SchemeResult } from "@plurnk/plurnk-execs";
import { serverConfig, isInjected, installAllowed, registerServer, deregisterServer, parseTarget } from "./config.ts";
import { connect, catalog, allTools, cacheHints, readOnlyHint, isAuthRequired, msg } from "./client.ts";
import { runtimeDecl } from "./runtimes.ts";

// Connection cache, OAuth overlay, readOnlyHint cache, and the live tool catalog
// live in client.ts. `closeAll`/`install` are re-exported from the barrel.

// MCP-bridge executor. Each configured server is one tag (this.runtime). The op
// is `EXEC[<server>](<tool>):<json-args>` — the tool is the (target) slot, its
// JSON arguments the body; a bare `EXEC[<server>]:` (or `?`/`help`) returns the
// live tool catalog (each tool's `inputSchema` + annotations included). Tool
// output is written as JSON to the `results` channel — contained behind the
// server's address, READ back rather than dumped inline. `effect()` gates per
// tool by `readOnlyHint`. Stateless beyond the module-level connection +
// readOnlyHint caches; configuration is read from the environment (see config.ts).
export default class Mcp extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    // Available iff the configured server is reachable and exposes tools.
    // A connection failure is settled unavailable so one dead server does not
    // fail boot.
    override async probe(): Promise<RuntimeAvailability> {
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            return { available: false, detail: `${ERROR_DETAIL_LIMIT} must be set to a non-negative integer.` };
        }
        const cfg = serverConfig(this.runtime);
        if (cfg === null) {
            return { available: false, detail: `MCP server '${this.runtime}' not configured (set PLURNK_EXECS_MCP_${this.runtime.toUpperCase()}=<url-or-command>)` };
        }
        try {
            const client = await connect(this.runtime, cfg);
            if (client.getServerCapabilities()?.tools === undefined) {
                return { available: false, detail: `${cfg.transport}: no tools advertised` };
            }
            const tools = await allTools(client);
            cacheHints(this.runtime, tools);
            return { available: true, detail: `${cfg.transport}: ${tools.length} tool${tools.length === 1 ? "" : "s"}` };
        } catch (err) {
            return { available: false, detail: `MCP '${this.runtime}' unreachable: ${ErrorDetail.preview(msg(err), detailLimit)}` };
        }
    }

    // The tool is the (target) slot, so it's visible to this sync hook — gate per
    // tool by its cached `readOnlyHint` (plurnk-execs#13): a read-only tool
    // auto-runs (`read`), a mutating OR not-yet-probed tool proposes (`host`,
    // conservative). No tool named = the catalog listing, which is read-only. The
    // hints come from probe()'s cached `listTools`, so this stays sync + cheap.
    override effect(target: string | null): Effect {
        if (target === null || target === "") return "read";
        return readOnlyHint(this.runtime, target) ? "read" : "host";
    }

    async run({ runtime, command, target, signal, write, setState }: ExecArgs): Promise<ExecResult> {
        const cfg = serverConfig(runtime);
        const fail = (
            kind: string,
            message: string,
            status = 500,
            extensions: Readonly<Record<string, unknown>> = {},
        ): ExecResult => {
            setState("results", "errored");
            return Results.failure(
                "executor:mcp",
                kind,
                status,
                message,
                {},
                {
                    runtime,
                    stage: "mcp",
                    ...extensions,
                },
            );
        };
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            setState("results", "errored");
            return ErrorDetail.invalidConfiguration("executor:mcp");
        }
        if (cfg === null) {
            return fail(
                "mcp-not-configured",
                `MCP server '${runtime}' is not configured.`,
                501,
                { retryable: false },
            );
        }
        // Defense in depth behind the consumer's route gate (#240): a runtime-injected
        // server is honored only while PLURNK_EXECS_MCP_INSTALL permits added tooling. An
        // env-declared server is never gated (isInjected is false for it).
        if (isInjected(runtime) && !installAllowed()) {
            return fail(
                "mcp-install-disabled",
                `Runtime installation of MCP server '${runtime}' is disabled.`,
                501,
                { retryable: false },
            );
        }

        let client: Client;
        try {
            client = await connect(runtime, cfg);
        } catch (err) {
            if (signal.aborted) {
                setState("results", "errored");
                return Results.failure(
                    "executor:mcp",
                    "cancelled",
                    499,
                    "MCP execution was cancelled.",
                    {},
                    {
                        runtime,
                        stage: "connect",
                        retryable: false,
                    },
                );
            }
            // An HTTP server that requires OAuth 401s the connect. The executor is
            // a PRODUCER — it can't run the interactive consent round-trip — so it
            // surfaces the need and stops. The consumer drives the RFC 8628 device
            // grant (oauth.ts `authorize` → show code → `poll` → bearer), injects
            // the token via install() / a PLURNK_EXECS_MCP_<server>_HEADERS
            // `Authorization: Bearer …`, and re-dispatches (plurnk-execs-mcp#2).
            if (isAuthRequired(err)) {
                setState("results", "errored");
                return Results.failure(
                    "executor:mcp",
                    "authentication-required",
                    401,
                    `MCP server '${runtime}' requires authorization.`,
                    {},
                    {
                        runtime,
                        resource: cfg.url,
                        stage: "connect",
                        recovery: "Authorize the MCP server before retrying.",
                        retryable: false,
                    },
                );
            }
            return fail(
                "mcp-unreachable",
                `MCP server '${runtime}' could not be reached: ${ErrorDetail.preview(msg(err), detailLimit)}.`,
                502,
                { stage: "connect", retryable: true },
            );
        }

        const body = command.trim();

        // The tool is the `(target)` slot; its JSON arguments are the body —
        // `EXEC[<server>](<tool>):<json-args>` (plurnk-execs#15). No tool named
        // (`EXEC[<server>]:` / `?` / `help`) → the live tool catalog, including
        // each server-provided input schema and annotations.
        if (target === null || target === "" || body === "?" || body === "help") {
            try {
                const cat = await catalog(runtime, client, signal);
                write("results", JSON.stringify(cat), "application/json");
                setState("results", "closed");
                return { status: 200 };
            } catch (err) {
                if (signal.aborted) {
                    setState("results", "errored");
                    return Results.failure(
                        "executor:mcp",
                        "cancelled",
                        499,
                        "MCP execution was cancelled.",
                        {},
                        {
                            runtime,
                            stage: "catalog",
                            retryable: false,
                        },
                    );
                }
                return fail(
                    "mcp-list-failed",
                    `MCP server '${runtime}' could not list its tools: ${ErrorDetail.preview(msg(err), detailLimit)}.`,
                    502,
                    { stage: "catalog", retryable: true },
                );
            }
        }

        const tool = target;
        let toolArgs: Record<string, unknown> = {};
        if (body !== "") {
            try {
                toolArgs = JSON.parse(body);
            } catch (err) {
                return fail(
                    "mcp-bad-arguments",
                    `Arguments for MCP tool '${tool}' are not valid JSON.`,
                    400,
                    {
                        stage: "arguments",
                        tool,
                        recovery: "Provide one JSON object as the tool arguments.",
                        retryable: false,
                    },
                );
            }
        }

        try {
            const result = await client.callTool({ name: tool, arguments: toolArgs }, { signal });
            write("results", JSON.stringify(result), "application/json");
            // An MCP tool reports its own failure via `isError` rather than
            // throwing; honor it as an errored close with a 500.
            const errored = result.isError === true;
            setState("results", errored ? "errored" : "closed");
            return errored
                ? Results.failure(
                    "executor:mcp",
                    "tool-reported-error",
                    500,
                    `MCP tool '${tool}' on '${runtime}' reported an error.`,
                    {},
                    {
                        runtime,
                        tool,
                        stage: "tool-call",
                        recovery: "Inspect the results channel for the tool's error response.",
                        retryable: false,
                    },
                )
                : { status: 200 };
        } catch (err) {
            if (signal.aborted) {
                setState("results", "errored");
                return Results.failure(
                    "executor:mcp",
                    "cancelled",
                    499,
                    "MCP execution was cancelled.",
                    {},
                    {
                        runtime,
                        tool,
                        stage: "tool-call",
                        retryable: false,
                    },
                );
            }
            return fail(
                "mcp-tool-error",
                `MCP tool '${tool}' on '${runtime}' failed: ${ErrorDetail.preview(msg(err), detailLimit)}.`,
                502,
                { stage: "tool-call", tool },
            );
        }
    }
}

// What the kernel needs to build a RegistryEntry and register a hotloaded tag —
// all execs-framework types the kernel already imports, so no execs-mcp → kernel
// edge (which would be circular: the kernel depends on execs-mcp). The consumer's
// `hotload` callback wraps these; the atomic dual-registry mutation + one-name-
// one-owner arbitration stay in the kernel (plurnk-service#355).
export interface HotloadRegistration {
    decl: RuntimeDecl;
    executor: BaseExecutor;
    availability: RuntimeAvailability;
}

export interface InstallServerResult extends SchemeResult {
    detail?: string;
}

// Install an MCP server as a live EXEC[<name>] runtime (plurnk-execs-mcp#3 /
// service#355). Self-contained MCP orchestration — the auth-precedent home:
// execs-mcp owns its mechanics, the kernel stays driver-agnostic behind the
// generic `hotload` seam. NOT to be confused with install() above (the OAuth
// bearer overlay). Probes before registering: a client-triggered install of a
// target that won't connect returns 502 and rolls back its injected config,
// rather than parking a dead tag (env-declared servers, operator-vetted, register
// while down — a different trust level). Gate: PLURNK_EXECS_MCP_INSTALL (the
// is-install-enabled boundary; who-may-install is the consumer's perimeter call).
export const installServer = async (
    name: string,
    { target, headers, hotload }: {
        target: string;
        headers?: Record<string, string>;
        hotload: (reg: HotloadRegistration) => void | Promise<void>;
    },
): Promise<InstallServerResult> => {
    if (!installAllowed()) {
        return Results.failure(
            "executor:mcp",
            "runtime-install-disabled",
            501,
            "Runtime MCP installation is disabled.",
            {},
            {
                stage: "install-gate",
                recovery: "Enable PLURNK_EXECS_MCP_INSTALL before installing an MCP server at runtime.",
                retryable: false,
            },
        ) as InstallServerResult;
    }
    registerServer(name, parseTarget(target, { headers }));
    const decl = runtimeDecl(name);
    const executor = new Mcp({ runtime: name, glyph: decl.glyph ?? "" });
    const availability = await executor.probe();
    if (!availability.available) {
        deregisterServer(name);
        return Results.failure(
            "executor:mcp",
            "runtime-server-unreachable",
            502,
            `MCP server '${name}' could not be reached during installation.`,
            {},
            {
                server: name,
                stage: "install-probe",
                diagnostic: availability.detail ?? null,
                retryable: true,
            },
        ) as InstallServerResult;
    }
    await hotload({ decl, executor, availability });
    return Results.assert({
        status: 200,
        detail: availability.detail ?? "installed",
    });
};
