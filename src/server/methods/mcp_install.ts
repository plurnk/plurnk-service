import type MethodRegistry from "../MethodRegistry.ts";
import { installAllowed, parseTarget, registerServer, runtimeDecl, Mcp } from "@plurnk/plurnk-execs-mcp";
import type { Executor, RegistryEntry } from "../../core/ExecutorRegistry.ts";

// mcp.install (#289 part 1) — the /mcp hotload route. An operator installs an MCP server LIVE and it
// becomes an EXEC[<name>] runtime (its tools called from the EXEC body, output READ back slice-wise).
// Gated by PLURNK_MCP_INSTALL (installAllowed): added tooling is an operator decision, off by default;
// the mcp executor re-checks the gate at connect (defense in depth, #240). execs-mcp mints the SAME
// runtime decl boot discovery mints for an env-declared server, so a hotloaded server is
// indistinguishable from a configured one, and it surfaces to the model on the next packet's tools
// sheet (rebuilt from the live registry). The connection is probed here — an unreachable server
// surfaces its detail and installs nothing, never a dead tag.
export default class McpInstallMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("mcp.install", {
            longRunning: true, // probes an external server — exempt from PLURNK_RPC_TIMEOUT (§operator-config-rpc-timeout)
            handler: async (params, ctx) => {
                const p = params as { name?: unknown; target?: unknown; headers?: unknown };
                if (typeof p.name !== "string" || p.name.length === 0) throw new Error("mcp.install: name must be a non-empty string");
                if (typeof p.target !== "string" || p.target.length === 0) throw new Error("mcp.install: target must be a non-empty string (an http(s) URL or a stdio command line)");
                const headers = McpInstallMethod.#parseHeaders(p.headers);

                // The gate — fail-hard (not a silent no-op) so the caller learns WHY nothing installed.
                if (!installAllowed()) throw new Error("mcp.install: runtime MCP install is disabled — set PLURNK_MCP_INSTALL=1 to permit it");

                const name = p.name.toLowerCase();
                const config = parseTarget(p.target, headers !== null ? { headers } : {});
                registerServer(name, config);

                // Mint the same decl boot mints, instantiate the mcp executor for this tag, and PROBE
                // it (connect + listTools) — an unreachable server surfaces its detail here, before it
                // ever reaches the model, and registers nothing.
                const decl = runtimeDecl(name);
                const glyph = decl.glyph ?? "";
                const executor = new Mcp({ runtime: name, glyph }) as unknown as Executor;
                const availability = await executor.probe();
                if (!availability.available) throw new Error(`mcp.install: '${name}' unreachable — ${availability.detail ?? "probe failed"}`);

                const entry: RegistryEntry = {
                    executor, glyph, example: decl.example ?? "", documentation: decl.documentation ?? "",
                    available: true, detail: availability.detail,
                };
                ctx.engine.hotloadRuntime(name, entry);
                return { name, available: true, detail: availability.detail ?? null };
            },
            description: "Install an MCP server as an EXEC[<name>] runtime at runtime (gated by PLURNK_MCP_INSTALL).",
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
