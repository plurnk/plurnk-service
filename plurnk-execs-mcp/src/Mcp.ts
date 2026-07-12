import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import { serverConfig, isInjected, installAllowed, setAuthHeaders, registerServer, deregisterServer, parseTarget, type ServerConfig } from "./config.ts";
import { runtimeDecl } from "./runtimes.ts";

const CLIENT_VERSION = "0.1.0";

// MCP connections are long-lived: open one Client per server, lazily, and reuse
// it across runs (the wasm `wabtPromise` singleton precedent). Keyed by tag
// name. A failed connection is evicted so the next call reconnects from scratch.
const clients = new Map<string, Promise<Client>>();

const connect = (name: string, cfg: ServerConfig): Promise<Client> => {
    const existing = clients.get(name);
    if (existing) return existing;
    const pending = open(cfg).catch((err: unknown) => {
        if (clients.get(name) === pending) clients.delete(name);
        throw err;
    });
    clients.set(name, pending);
    return pending;
};

const open = async (cfg: ServerConfig): Promise<Client> => {
    const transport = cfg.transport === "stdio"
        ? new StdioClientTransport({ command: cfg.command!, args: cfg.args, env: { ...getDefaultEnvironment(), ...cfg.env } })
        : new StreamableHTTPClientTransport(new URL(cfg.url!), cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined);
    const client = new Client({ name: "plurnk-execs-mcp", version: CLIENT_VERSION });
    await client.connect(transport);
    return client;
};

// Disconnect every open MCP server and drop the cache. The consumer calls this
// on daemon shutdown so child stdio servers don't leak; idempotent and never
// throws (a close failure on one server doesn't block the rest).
export async function closeAll(): Promise<void> {
    const open = [...clients.values()];
    clients.clear();
    await Promise.allSettled(open.map(async (p) => { (await p).close(); }));
}

// Inject the OAuth bearer (from a completed device-grant poll) for a server and evict its cached
// client so the next connect carries the token (plurnk-execs-mcp#1). This is the
// correct injection primitive for an env-declared server: it overlays the token
// on the resolved config (registerServer can't — an env server wins over an
// injected rival). Any env `_HEADERS` still apply; the token merges over them.
export function install(server: string, headers: Record<string, string>): void {
    setAuthHeaders(server, headers);
    clients.delete(server.toLowerCase());
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A connect failure that means "this server wants OAuth". With no authProvider
// wired (the consumer owns the flow), the SDK surfaces a 401 as an
// `UnauthorizedError` on the auth-start path OR a `StreamableHTTPError` carrying
// `code: 401` on a plain request — catch both.
const isAuthRequired = (err: unknown): boolean =>
    err instanceof UnauthorizedError || (err as { code?: unknown })?.code === 401;

// Per-tool `readOnlyHint`, cached from `listTools` (probe + catalog). effect()
// is a sync/cheap/no-I/O hook, so it can't fetch the catalog itself — it reads
// this cache. With the tool now in the (target) slot (visible to effect), a
// read-only tool can auto-run and a mutating one propose — the per-tool gating
// plurnk-execs#13 parked while the tool lived in the body. Keyed server → tool.
const readOnlyHints = new Map<string, Map<string, boolean>>();

const cacheHints = (server: string, tools: readonly { name: string; annotations?: { readOnlyHint?: boolean } }[]): void => {
    readOnlyHints.set(server, new Map(tools.map((t) => [t.name, t.annotations?.readOnlyHint === true])));
};

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

    // Available iff the server is configured AND reachable, reporting its tool
    // count — boot answers "is this MCP server up?". A connection failure is a
    // settled unavailable, not a throw, so one dead server doesn't fail boot.
    override async probe(): Promise<RuntimeAvailability> {
        const cfg = serverConfig(this.runtime);
        if (cfg === null) {
            return { available: false, detail: `MCP server '${this.runtime}' not configured (set PLURNK_EXECS_MCP_${this.runtime.toUpperCase()}=<url-or-command>)` };
        }
        try {
            const { tools } = await connect(this.runtime, cfg).then((c) => c.listTools());
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
        return readOnlyHints.get(this.runtime)?.get(target) === true ? "read" : "host";
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
        // (`EXEC[<server>]:` / `?` / `help`) → the live tool catalog.
        if (target === null || target === "" || body === "?" || body === "help") {
            try {
                const { tools } = await client.listTools(undefined, { signal });
                cacheHints(runtime, tools);
                write("results", JSON.stringify(tools), "application/json");
                setState("results", "closed");
                return { status: 200 };
            } catch (err) {
                if (signal.aborted) { setState("results", "errored"); return { status: 499 }; }
                return fail("mcp_list_failed", `listing tools for '${runtime}' failed: ${msg(err)}`);
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
