import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";
import { serverConfig, isInjected, installAllowed, type ServerConfig } from "./config.ts";

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

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// MCP-bridge executor. Each configured server is one tag (this.runtime); the
// EXEC body is `<tool_name> <json-args>` (or empty / `?` / `help` for the live
// tool catalog). Tool output is written as JSON to the `results` channel —
// contained behind the server's address, READ back rather than dumped inline.
// Stateless beyond the module-level connection cache; configuration is read from
// the environment per run (see config.ts).
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
            return { available: false, detail: `MCP server '${this.runtime}' not configured (set PLURNK_MCP_${this.runtime.toUpperCase()}=<url-or-command>)` };
        }
        try {
            const { tools } = await connect(this.runtime, cfg).then((c) => c.listTools());
            return { available: true, detail: `${cfg.transport}: ${tools.length} tool${tools.length === 1 ? "" : "s"}` };
        } catch (err) {
            return { available: false, detail: `MCP '${this.runtime}' unreachable: ${msg(err)}` };
        }
    }

    // Conservative `host` for every call: the side-effect class depends on which
    // tool the body names and the server's per-tool annotations, neither visible
    // to this target-only, synchronous hook — so MCP calls are always
    // proposal-gated. Finer auto-vs-propose by `readOnlyHint` awaits a
    // command-aware gating hook in the consumer.
    override effect(_target: string | null): Effect {
        return "host";
    }

    async run({ runtime, command, signal, write, setState, emit }: ExecArgs): Promise<ExecResult> {
        const cfg = serverConfig(runtime);
        const fail = (kind: string, message: string, status = 500): ExecResult => {
            emit({ source: `exec:${runtime}`, kind, message });
            setState("results", "errored");
            return { status };
        };
        if (cfg === null) return fail("mcp_not_configured", `MCP server '${runtime}' is not configured`);
        // Defense in depth behind the consumer's route gate (#240): a runtime-injected
        // server is honored only while PLURNK_MCP_INSTALL permits added tooling. An
        // env-declared server is never gated (isInjected is false for it).
        if (isInjected(runtime) && !installAllowed()) {
            return fail("mcp_install_disabled", `MCP server '${runtime}' was added at runtime but PLURNK_MCP_INSTALL is off`, 501);
        }

        let client: Client;
        try {
            client = await connect(runtime, cfg);
        } catch (err) {
            if (signal.aborted) { setState("results", "errored"); return { status: 499 }; }
            return fail("mcp_unreachable", `MCP '${runtime}' connect failed: ${msg(err)}`);
        }

        const body = command.trim();

        // Empty / `?` / `help` body → the live tool catalog.
        if (body === "" || body === "?" || body === "help") {
            try {
                const { tools } = await client.listTools(undefined, { signal });
                write("results", JSON.stringify(tools), "application/json");
                setState("results", "closed");
                return { status: 200 };
            } catch (err) {
                if (signal.aborted) { setState("results", "errored"); return { status: 499 }; }
                return fail("mcp_list_failed", `listing tools for '${runtime}' failed: ${msg(err)}`);
            }
        }

        // `<tool_name> <json-args>` — split on the first whitespace run.
        const sep = body.search(/\s/);
        const tool = sep === -1 ? body : body.slice(0, sep);
        const argsRaw = sep === -1 ? "" : body.slice(sep + 1).trim();
        let toolArgs: Record<string, unknown> = {};
        if (argsRaw !== "") {
            try {
                toolArgs = JSON.parse(argsRaw);
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
