import {
    Client,
    SdkHttpError,
    StreamableHTTPClientTransport,
    UnauthorizedError,
    type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { setAuthHeaders, type ServerConfig } from "./config.ts";

const CLIENT_VERSION = "0.1.0";

// Executor connection state: one cache, one OAuth overlay, and one live tool
// catalog per configured server.

// MCP connections are long-lived: open one Client per server, lazily, and reuse
// it across runs (the wasm `wabtPromise` singleton precedent). Keyed by tag
// name. A failed connection is evicted so the next call reconnects from scratch.
const clients = new Map<string, Promise<Client>>();

export const connect = (name: string, cfg: ServerConfig): Promise<Client> => {
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

export const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A connect failure that means "this server wants OAuth". With no authProvider
// wired (the consumer owns the flow), the SDK surfaces a 401 as an
// `UnauthorizedError` on the auth-start path or `SdkHttpError.data.status=401`
// on a plain request.
export const isAuthRequired = (err: unknown): boolean =>
    err instanceof UnauthorizedError || (err instanceof SdkHttpError && err.data.status === 401);

// Per-tool `readOnlyHint`, cached from `listTools` (probe + catalog). effect()
// is a sync/cheap/no-I/O hook, so it can't fetch the catalog itself — it reads
// this cache. With the tool in the (target) slot (visible to effect), a
// read-only tool can auto-run and a mutating one propose — the per-tool gating
// plurnk-execs#13 parked while the tool lived in the body. Keyed server → tool.
const readOnlyHints = new Map<string, Map<string, boolean>>();

export const readOnlyHint = (server: string, tool: string): boolean =>
    readOnlyHints.get(server)?.get(tool) === true;

export const cacheHints = (server: string, tools: readonly { name: string; annotations?: { readOnlyHint?: boolean } }[]): void => {
    readOnlyHints.set(server, new Map(tools.map((t) => [t.name, t.annotations?.readOnlyHint === true])));
};

// The model-visible catalog contains only actionable executor capabilities.
// Every tool retains the server-provided input schema and annotations.
export interface Catalog {
    tools: Tool[];
}

export const catalog = async (server: string, client: Client, signal?: AbortSignal): Promise<Catalog> => {
    const caps = client.getServerCapabilities() ?? {};
    if (caps.tools === undefined) return { tools: [] };
    const opts = signal === undefined ? undefined : { signal };
    const tools = await allTools(client, opts);
    cacheHints(server, tools);
    return { tools };
};

// Every list call follows `nextCursor` to exhaustion — a multi-page server must
// never silently truncate its catalog (MCP pagination; #484). One page is the
// common case and costs one round-trip either way.
const paginate = async <R extends { nextCursor?: string }, T>(
    opts: { signal?: AbortSignal } | undefined,
    list: (params: { cursor: string } | undefined, opts?: { signal?: AbortSignal }) => Promise<R>,
    pick: (result: R) => T[],
): Promise<T[]> => {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
        const result = await list(cursor === undefined ? undefined : { cursor }, opts);
        out.push(...pick(result));
        cursor = result.nextCursor;
    } while (cursor !== undefined);
    return out;
};

// The full tool list (paginated), shared by probe and the live catalog.
export const allTools = (client: Client, opts?: { signal?: AbortSignal }): Promise<Tool[]> =>
    paginate(opts, (p, o) => client.listTools(p, o), (r) => r.tools);
