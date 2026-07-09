import type MethodRegistry from "../MethodRegistry.ts";
import type { Executor } from "../../core/ExecutorRegistry.ts";
import { installServer } from "@plurnk/plurnk-execs-mcp";

// mcp.install (#289 / #355 plan C) — a thin relay: the execs-mcp driver owns install end-to-end
// (the PLURNK_EXECS_MCP_INSTALL gate → 501, parseTarget/registerServer, the connect-probe with
// dead-target rollback → 502), and the daemon's hotloadRuntime is the registration callback.
// This method holds only wire validation; it retires with the WS surface at agui cutover.
export default class McpInstallMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("mcp.install", {
            longRunning: true, // probes an external server — exempt from PLURNK_SERVICE_RPC_TIMEOUT (§operator-config-rpc-timeout)
            handler: async (params, ctx) => {
                const p = params as { name?: unknown; target?: unknown; headers?: unknown };
                if (typeof p.name !== "string" || p.name.length === 0) throw new Error("mcp.install: name must be a non-empty string");
                if (typeof p.target !== "string" || p.target.length === 0) throw new Error("mcp.install: target must be a non-empty string (an http(s) URL or a stdio command line)");
                const headers = McpInstallMethod.#parseHeaders(p.headers);

                const name = p.name.toLowerCase();
                const { status, detail } = await installServer(name, {
                    target: p.target,
                    ...(headers !== null ? { headers } : {}),
                    // BaseExecutor satisfies the kernel's Executor structurally — same cast boot's load path uses.
                    hotload: (reg) => ctx.daemon.hotloadRuntime({ ...reg, executor: reg.executor as unknown as Executor }),
                });
                if (status !== 200) throw new Error(`mcp.install: ${detail}`);
                return { name, available: true, detail };
            },
            description: "Install an MCP server as an EXEC[<name>] runtime at runtime (gated by PLURNK_EXECS_MCP_INSTALL).",
            params: {
                name: "server name — becomes the EXEC tag",
                target: "http(s) URL (→ streamable-http) or a stdio command line",
                headers: "optional header map merged into the transport (e.g. Authorization: Bearer …)",
            },
            requiresInit: true,
        });
    }

    static #parseHeaders(raw: unknown): Record<string, string> | null {
        if (raw === undefined || raw === null) return null;
        if (typeof raw !== "object") throw new Error("mcp.install: headers must be an object of string values");
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof v !== "string") throw new Error(`mcp.install: header '${k}' must be a string`);
            out[k] = v;
        }
        return out;
    }
}
