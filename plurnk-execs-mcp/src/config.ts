// Per-server configuration, mirroring the model-alias convention
// (PLURNK_MODEL_<alias>=<provider>/<model>, plurnk-providers): one env var per
// server, the server IS the var, and the set is discovered by ENUMERATING the
// namespace — no separate list var. The suffix case-folds to the tag.
//
//   PLURNK_MCP_<server>          = <target>   the server. Target is an http(s)
//                                             URL (streamable-HTTP transport) or
//                                             a command line (stdio transport).
//   PLURNK_MCP_<server>_ENV      = <json>     stdio: env overlay for the child (tokens)
//   PLURNK_MCP_<server>_HEADERS  = <json>     http:  request headers (auth)
//   PLURNK_MCP_INSTALL           = 0|1        daemon gate: may arbitrary MCP
//                                             tooling be ADDED at runtime (the
//                                             /mcp hotload route)? Default off.
//
// Servers case-fold (PLURNK_MCP_github === PLURNK_MCP_GITHUB); two keys folding
// to the same server is fail-hard, exactly as model aliases are. `_ENV` /
// `_HEADERS` are reserved companion suffixes and `INSTALL` is a reserved control
// key, so a server can't be named to end in those or to be named `install`.
// This module is SDK-free — it only parses the environment, so the runtimes
// hook that imports it pulls no transport code at discovery time.

const PREFIX = "PLURNK_MCP_";
const ENV_SUFFIX = "_env";
const HEADERS_SUFFIX = "_headers";

// Reserved control keys in the PLURNK_MCP_* namespace — daemon switches, never
// servers. (A server therefore can't be named for one of these.)
const CONTROL_KEYS = new Set(["install"]);

// Transport config for one server. `stdio` spawns `command args…` with an env
// overlay; `http` connects to `url` with optional headers.
export interface ServerConfig {
    transport: "stdio" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
}

interface Parsed {
    targets: Map<string, string>;
    envs: Map<string, string>;
    headers: Map<string, string>;
}

// One pass over the environment, partitioning `PLURNK_MCP_*` into server targets
// and their `_ENV` / `_HEADERS` companions (all keyed by the case-folded server
// name). The prefix is fixed upper-case; only the suffix case varies, so the
// user's `PLURNK_MCP_github` and a conventional `PLURNK_MCP_GITHUB` both resolve.
const parse = (environ: NodeJS.ProcessEnv): Parsed => {
    const targets = new Map<string, string>();
    const envs = new Map<string, string>();
    const headers = new Map<string, string>();
    for (const [key, value] of Object.entries(environ)) {
        if (value === undefined || !key.startsWith(PREFIX)) continue;
        const suffix = key.slice(PREFIX.length);
        if (suffix.length === 0) continue;
        const name = suffix.toLowerCase();
        if (CONTROL_KEYS.has(name)) continue; // a daemon control switch, not a server
        if (name.endsWith(ENV_SUFFIX)) { envs.set(name.slice(0, -ENV_SUFFIX.length), value); continue; }
        if (name.endsWith(HEADERS_SUFFIX)) { headers.set(name.slice(0, -HEADERS_SUFFIX.length), value); continue; }
        if (targets.has(name)) throw new Error(`Duplicate MCP server "${name}": multiple ${PREFIX}* keys case-fold to the same server. Rename one.`);
        targets.set(name, value);
    }
    return { targets, envs, headers };
};

// Parse an env value as a JSON object, fail-hard on malformed config — a
// declared but unparseable companion is an operator mistake, surfaced not
// dropped. Absent → undefined.
const jsonRecord = (raw: string | undefined, what: string): Record<string, string> | undefined => {
    if (!raw) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error(`${what} must be a JSON object`, { cause });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${what} must be a JSON object`);
    return parsed as Record<string, string>;
};

// Whether the daemon permits ADDING arbitrary MCP tooling at runtime (the /mcp
// hotload route) — the single security boundary for runtime registration.
// Env-declared servers are always honored; only runtime-injected,
// operator-unvetted servers are gated by this. Enabling/disabling an
// already-present tag is NOT gated. Default OFF (absent / "" / "0"); opt in with
// PLURNK_MCP_INSTALL=1. Mirrors the trust-gate truthiness convention.
export const installAllowed = (env: NodeJS.ProcessEnv = process.env): boolean => {
    const gate = env.PLURNK_MCP_INSTALL;
    return !(gate === undefined || gate === "" || gate === "0");
};

// The configured server names (= the tags), case-folded and sorted. Empty when
// none are set.
export const serverNames = (env: NodeJS.ProcessEnv = process.env): string[] =>
    [...parse(env).targets.keys()].sort();

// Resolve a server's transport config. An http(s) URL target → http; anything
// else → a stdio command line. null when the server names no target.
export const serverConfig = (name: string, env: NodeJS.ProcessEnv = process.env): ServerConfig | null => {
    const { targets, envs, headers } = parse(env);
    const key = name.toLowerCase();
    const target = targets.get(key);
    if (target === undefined) return null;
    if (/^https?:\/\//i.test(target)) {
        return { transport: "http", url: target, headers: jsonRecord(headers.get(key), `${PREFIX}${key.toUpperCase()}_HEADERS`) };
    }
    const [command, ...args] = target.split(/\s+/);
    return { transport: "stdio", command, args, env: jsonRecord(envs.get(key), `${PREFIX}${key.toUpperCase()}_ENV`) };
};
