import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import { serverConfig, isInjected, installAllowed, registerServer, deregisterServer, parseTarget } from "./config.ts";
import { connect, catalog, cacheHints, readOnlyHint, isAuthRequired, msg } from "./client.ts";
import { runtimeDecl } from "./runtimes.ts";

// Connection cache, OAuth overlay, readOnlyHint cache, and the capability-aware
// catalog live in client.ts — shared with the mcp:// scheme face (McpScheme.ts).
// `closeAll`/`install` are re-exported from the barrel unchanged.

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

    // Available iff the server is configured AND reachable, reporting its
    // advertised primitives — boot answers "is this MCP server up?". Tools list
    // only when the tools capability is negotiated (a resources-only server is
    // available, not a listTools failure). A connection failure is a settled
    // unavailable, not a throw, so one dead server doesn't fail boot.
    override async probe(): Promise<RuntimeAvailability> {
        const cfg = serverConfig(this.runtime);
        if (cfg === null) {
            return { available: false, detail: `MCP server '${this.runtime}' not configured (set PLURNK_EXECS_MCP_${this.runtime.toUpperCase()}=<url-or-command>)` };
        }
        try {
            const client = await connect(this.runtime, cfg);
            const caps = client.getServerCapabilities() ?? {};
            const parts: string[] = [];
            if (caps.tools !== undefined) {
                const { tools } = await client.listTools();
                cacheHints(this.runtime, tools);
                parts.push(`${tools.length} tool${tools.length === 1 ? "" : "s"}`);
            }
            if (caps.resources !== undefined) parts.push("resources");
            if (caps.prompts !== undefined) parts.push("prompts");
            return { available: true, detail: `${cfg.transport}: ${parts.length > 0 ? parts.join(", ") : "no primitives advertised"}` };
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

    async run({ runtime, command, target, signal, write, setState, emit }: ExecArgs): Promise<ExecResult> {
        const cfg = serverConfig(runtime);
        const fail = (kind: string, message: string, status = 500): ExecResult => {
            emit({ source: `exec:${runtime}`, kind, message });
            setState("results", "errored");
            return { status };
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
            if (signal.aborted) { setState("results", "errored"); return { status: 499 }; }
            // An HTTP server that requires OAuth 401s the connect. The executor is
            // a PRODUCER — it can't run the interactive consent round-trip — so it
            // surfaces the need and stops. The consumer drives the RFC 8628 device
            // grant (oauth.ts `authorize` → show code → `poll` → bearer), injects
            // the token via install() / a PLURNK_EXECS_MCP_<server>_HEADERS
            // `Authorization: Bearer …`, and re-dispatches (plurnk-execs-mcp#2).
            if (isAuthRequired(err)) {
                emit({ source: `exec:${runtime}`, kind: "mcp_auth_required", message: `MCP server '${runtime}' requires authorization`, server: runtime, resource: cfg.url });
                setState("results", "errored");
                return { status: 401 };
            }
            return fail("mcp_unreachable", `MCP '${runtime}' connect failed: ${msg(err)}`);
        }

        const body = command.trim();

        // The tool is the `(target)` slot; its JSON arguments are the body —
        // `EXEC[<server>](<tool>):<json-args>` (plurnk-execs#15). No tool named
        // (`EXEC[<server>]:` / `?` / `help`) → the live capability-aware catalog
        // (tools + resources + prompts, per what the server advertises — #484),
        // identical to the mcp://<server>/ index.
        if (target === null || target === "" || body === "?" || body === "help") {
            try {
                const cat = await catalog(runtime, client, signal);
                write("results", JSON.stringify(cat), "application/json");
                setState("results", "closed");
                return { status: 200 };
            } catch (err) {
                if (signal.aborted) { setState("results", "errored"); return { status: 499 }; }
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
            const result = await client.callTool({ name: tool, arguments: toolArgs }, undefined, { signal });
            write("results", JSON.stringify(result), "application/json");
            // An MCP tool reports its own failure via `isError` rather than
            // throwing; honor it as an errored close with a 500.
            const errored = result.isError === true;
            setState("results", errored ? "errored" : "closed");
            return { status: errored ? 500 : 200 };
        } catch (err) {
            if (signal.aborted) { setState("results", "errored"); return { status: 499 }; }
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
