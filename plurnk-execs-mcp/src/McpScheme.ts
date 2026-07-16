// mcp:// scheme handler — the plugin-owned READ face for MCP server-side state
// (#484). The executor face (Mcp.ts) CALLS tools — `EXEC[<server>](<tool>)` —
// and those results land at `<server>://<coord>` like every tag's output; THIS
// face reads what the server itself HOLDS. Whoever owns the state names the
// address: results are plurnk events (tag://), server state is the server's
// (mcp://).
//
//   READ(mcp://<server>/)                          capability-aware catalog
//   READ(mcp://<server>/tools/<name>)              one tool's schema + annotations
//   READ(mcp://<server>/resources/<encoded-uri>)   readResource — the resource URI
//                                                  rides as ONE encodeURIComponent-
//                                                  encoded path segment (#484)
//   READ(mcp://<server>/prompts/<name>?<args>)     getPrompt — string-valued
//                                                  arguments as query params
//
// Network exception: the schemes SPEC §forbidden table bars connections "unless
// specifically a network scheme" — like http, this IS one. It shares the
// connection cache / OAuth overlay / env config with the executor face (one
// protocol, one package, both faces — #483), and owns no substrate machinery:
// content lands through the streaming caps exactly as http's does.

import { readFile } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
    PassthroughResult,
    ReadStatement,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
    UrlPath,
    EntryData,
} from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";
import { serverConfig, isInjected, installAllowed } from "./config.ts";
import { connect, catalog, allTools, cacheHints, isAuthRequired, msg, type Catalog } from "./client.ts";

const BODY = "body";
const JSON_MIME = "application/json";

// Deep doc lives in `docs/mcp.md` (the constellation's docs/<name>.md
// convention) and is loaded into the manifest at module init. Missing file →
// fail-hard at import (`../docs/mcp.md` resolves identically from src/ and dist/).
const documentation = await readFile(new URL("../docs/mcp.md", import.meta.url), "utf-8");

type Route =
    | { kind: "index" }
    | { kind: "tool"; name: string }
    | { kind: "resource"; uri: string }
    | { kind: "prompt"; name: string };

// An exact failure inside #serve — carries the status + telemetry kind through
// the single close-errored path (unadvertised primitive, unknown tool, bad args).
class RouteError extends Error {
    readonly status: number;
    readonly kind: string;
    constructor(status: number, kind: string, message: string) {
        super(message);
        this.status = status;
        this.kind = kind;
    }
}

export default class McpScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "mcp",
        // Seed default — catalogs/schemas/prompts are JSON; a single-part text
        // resource retypes the channel to its OWN mimeType via notifyChunk.
        channels: { [BODY]: JSON_MIME },
        defaultChannel: BODY,
        category: "data",
        scope: "session",
        writableBy: ["model", "client"],
        volatile: true, // server state changes between reads
        modelVisible: true,
        glyph: "🔌",
        example: "<<READ(mcp://<server>/)::READ",
        documentation,
    };

    // READ → one MCP request, streamed as one chunk (the http idiom: seed the
    // entry, open the subscription, fetch, notifyChunk, close — the model reads
    // the entry next turn). Returns 102 Processing.
    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        const target = statement.target;
        if (target === null || target.kind !== "url" || target.hostname === null || target.hostname === "") {
            return McpScheme.#bad(400, "bad_target", "READ requires an mcp://<server>/… target");
        }
        const server = target.hostname.toLowerCase();
        const route = McpScheme.#route(target.pathname);
        if (route === null) {
            return McpScheme.#bad(400, "bad_path", `unknown mcp:// path '${target.pathname}' — /, /tools/<name>, /resources/<encoded-uri>, or /prompts/<name>`);
        }

        const cfg = serverConfig(server);
        if (cfg === null) return McpScheme.#bad(404, "mcp_not_configured", `MCP server '${server}' is not configured`);
        // Defense in depth behind the consumer's route gate — the same rule the
        // executor face applies: a runtime-injected server is honored only while
        // PLURNK_EXECS_MCP_INSTALL permits added tooling.
        if (isInjected(server) && !installAllowed()) {
            return McpScheme.#bad(501, "mcp_install_disabled", `MCP server '${server}' was added at runtime but PLURNK_EXECS_MCP_INSTALL is off`);
        }

        let client: Client;
        try {
            client = await connect(server, cfg);
        } catch (err) {
            if (isAuthRequired(err)) return McpScheme.#bad(401, "mcp_auth_required", `MCP server '${server}' requires authorization`);
            return McpScheme.#bad(502, "mcp_unreachable", `MCP '${server}' connect failed: ${msg(err)}`);
        }

        // Entry key is server-qualified — two servers' identical paths must
        // never collide within the scheme's namespace.
        const pathname = `${server}${target.pathname === "" ? "/" : target.pathname}`;
        await ctx.entries.write(pathname, McpScheme.#seedEntry());
        const local = new AbortController();
        const composed = await ctx.subscriptions.open(pathname, { cancel: () => local.abort() });
        const onAbort = () => local.abort();
        composed.addEventListener("abort", onAbort, { once: true });
        try {
            const { content, mimetype, summary } = await McpScheme.#serve(route, server, client, target, local.signal);
            await ctx.subscriptions.notifyChunk(BODY, content, mimetype);
            await ctx.subscriptions.close("done", summary);
            return { shape: "passthrough", status: 102 };
        } catch (err) {
            const aborted = local.signal.aborted;
            const reason = aborted ? "aborted" : msg(err);
            await ctx.subscriptions.close("error", reason);
            if (aborted) return McpScheme.#bad(499, "aborted", reason);
            if (err instanceof RouteError) return McpScheme.#bad(err.status, err.kind, err.message);
            return McpScheme.#bad(502, "mcp_read_failed", `${route.kind} read on '${server}' failed: ${reason}`);
        } finally {
            composed.removeEventListener("abort", onAbort);
        }
    }

    // One request per route, each gated by the server's ADVERTISED capabilities
    // — an unadvertised primitive fails exactly (501 mcp_unadvertised), never as
    // a generic transport error.
    static async #serve(route: Route, server: string, client: Client, target: UrlPath, signal: AbortSignal): Promise<{ content: string; mimetype: string; summary: string }> {
        const caps = client.getServerCapabilities() ?? {};
        const opts = { signal };
        switch (route.kind) {
            case "index": {
                const cat = await catalog(server, client, signal);
                return { content: JSON.stringify(cat), mimetype: JSON_MIME, summary: `catalog: ${McpScheme.#summarize(cat)}` };
            }
            case "tool": {
                if (caps.tools === undefined) throw new RouteError(501, "mcp_unadvertised", `MCP server '${server}' does not advertise tools`);
                const tools = await allTools(client, opts);
                cacheHints(server, tools);
                const tool = tools.find((t) => t.name === route.name);
                if (tool === undefined) throw new RouteError(404, "mcp_unknown_tool", `no tool '${route.name}' on '${server}'`);
                return { content: JSON.stringify(tool), mimetype: JSON_MIME, summary: `tool ${route.name}` };
            }
            case "resource": {
                if (caps.resources === undefined) throw new RouteError(501, "mcp_unadvertised", `MCP server '${server}' does not advertise resources`);
                const { contents } = await client.readResource({ uri: route.uri }, opts);
                const only = contents.length === 1 ? contents[0] : undefined;
                const text = only === undefined ? undefined : (only as { text?: unknown }).text;
                if (typeof text === "string") {
                    return { content: text, mimetype: only!.mimeType ?? "text/plain", summary: `resource ${route.uri}; ${text.length} chars` };
                }
                // Multi-part or binary (base64 blob) — the honest JSON envelope.
                return { content: JSON.stringify(contents), mimetype: JSON_MIME, summary: `resource ${route.uri}; ${contents.length} part(s)` };
            }
            case "prompt": {
                if (caps.prompts === undefined) throw new RouteError(501, "mcp_unadvertised", `MCP server '${server}' does not advertise prompts`);
                const args = McpScheme.#promptArgs(target.params);
                const result = await client.getPrompt({ name: route.name, ...(args === undefined ? {} : { arguments: args }) }, opts);
                return { content: JSON.stringify(result), mimetype: JSON_MIME, summary: `prompt ${route.name}; ${result.messages.length} message(s)` };
            }
        }
    }

    // `/` → index; `/tools/<name>`, `/resources/<seg>`, `/prompts/<name>`.
    // The resource segment decodes ONCE (#484's encoding rule) — an unencoded
    // URI without reserved characters passes through the decode unchanged, so
    // the lenient spelling also resolves.
    static #route(pathname: string): Route | null {
        if (pathname === "" || pathname === "/") return { kind: "index" };
        const m = /^\/(tools|resources|prompts)\/(.+)$/.exec(pathname);
        if (m === null) return null;
        if (m[1] === "tools") return { kind: "tool", name: m[2] };
        if (m[1] === "prompts") return { kind: "prompt", name: m[2] };
        return { kind: "resource", uri: decodeURIComponent(m[2]) };
    }

    // MCP prompt arguments are single string values; a repeated query key is the
    // one shape that can't map — surfaced exactly, not last-one-wins.
    static #promptArgs(params: Record<string, string | string[]>): Record<string, string> | undefined {
        const entries = Object.entries(params);
        if (entries.length === 0) return undefined;
        return Object.fromEntries(entries.map(([key, value]) => {
            if (Array.isArray(value)) throw new RouteError(400, "mcp_bad_arguments", `prompt argument '${key}' given more than once — MCP prompt arguments are single string values`);
            return [key, value];
        }));
    }

    static #summarize(cat: Catalog): string {
        const parts: string[] = [];
        if (cat.tools !== undefined) parts.push(`${cat.tools.length} tools`);
        if (cat.resources !== undefined) parts.push(`${cat.resources.length} resources`);
        if (cat.resourceTemplates !== undefined && cat.resourceTemplates.length > 0) parts.push(`${cat.resourceTemplates.length} templates`);
        if (cat.prompts !== undefined) parts.push(`${cat.prompts.length} prompts`);
        return parts.length > 0 ? parts.join(", ") : "no primitives advertised";
    }

    // Seed entry mirroring the manifest's channels — the channel-shape knowledge
    // open() lacks; the scheme materializes the target so the subscription binds
    // an existing entry (the http precedent).
    static #seedEntry(): EntryData {
        const channels = Object.fromEntries(
            Object.entries(McpScheme.manifest.channels).map(([name, mimetype]) => [name, { content: "", mimetype }]),
        );
        return { channels, tags: [] };
    }

    static #bad(status: number, kind: string, message: string): PassthroughResult {
        return { shape: "passthrough", status, error: Results.error("mcp", kind, message) };
    }
}
