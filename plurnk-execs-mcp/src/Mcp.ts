import type { Client } from "@modelcontextprotocol/client";
import { BaseExecutor, Results } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
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
            return { available: false, detail: `MCP '${this.runtime}' unreachable: ${msg(err)}` };
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
        const fail = (kind: string, message: string, status = 500): ExecResult => {
            setState("results", "errored");
            return Results.failure("executor:mcp", kind.replaceAll("_", "-"), status, message, {}, { runtime });
        };
        if (cfg === null) return fail("mcp_not_configured", `MCP server '${runtime}' is not configured`);
        // Defense in depth behind the consumer's route gate (#240): a runtime-injected
        // server is honored only while PLURNK_EXECS_MCP_INSTALL permits added tooling. An
        // env-declared server is never gated (isInjected is false for it).
        if (isInjected(runtime) && !installAllowed()) {
            return fail("mcp_install_disabled", `MCP server '${runtime}' was added at runtime but PLURNK_EXECS_MCP_INSTALL is off`, 501);
        }

        let client: Client;
        try {
            client = await connect(runtime, cfg);
        } catch (err) {
            if (signal.aborted) {
                setState("results", "errored");
                return Results.failure("executor:mcp", "cancelled", 499, "MCP execution was cancelled.", {}, { runtime });
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
                    { runtime, resource: cfg.url },
                );
            }
            return fail("mcp_unreachable", `MCP '${runtime}' connect failed: ${msg(err)}`);
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
                    return Results.failure("executor:mcp", "cancelled", 499, "MCP execution was cancelled.", {}, { runtime });
                }
                return fail("mcp_list_failed", `catalog for '${runtime}' failed: ${msg(err)}`);
            }
        }

        const tool = target;
        let toolArgs: Record<string, unknown> = {};
        if (body !== "") {
            try {
                toolArgs = JSON.parse(body);
            } catch (err) {
                return fail("mcp_bad_arguments", `tool arguments for '${tool}' must be a JSON object: ${msg(err)}`, 400);
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
                    { runtime, tool },
                )
                : { status: 200 };
        } catch (err) {
            if (signal.aborted) {
                setState("results", "errored");
                return Results.failure("executor:mcp", "cancelled", 499, "MCP execution was cancelled.", {}, { runtime });
            }
            return fail("mcp_tool_error", `tool '${tool}' on '${runtime}' failed: ${msg(err)}`);
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
): Promise<{ status: number; detail: string }> => {
    if (!installAllowed()) return { status: 501, detail: "runtime install disabled (PLURNK_EXECS_MCP_INSTALL is off)" };
    registerServer(name, parseTarget(target, { headers }));
    const decl = runtimeDecl(name);
    const executor = new Mcp({ runtime: name, glyph: decl.glyph ?? "" });
    const availability = await executor.probe();
    if (!availability.available) {
        deregisterServer(name);
        return { status: 502, detail: availability.detail ?? `MCP server '${name}' unreachable` };
    }
    await hotload({ decl, executor, availability });
    return { status: 200, detail: availability.detail ?? "installed" };
};
