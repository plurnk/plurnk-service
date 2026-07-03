// Per-server configuration, mirroring the model-alias convention
// (PLURNK_MODEL_<alias>=<provider>/<model>, plurnk-providers): one env var per
// server, the server IS the var, and the set is discovered by ENUMERATING the
// namespace — no separate list var. The suffix case-folds to the tag.
//
//   PLURNK_EXECS_MCP_<server>          = <target>   the server. Target is an http(s)
//                                             URL (streamable-HTTP transport) or
//                                             a command line (stdio transport).
//   PLURNK_EXECS_MCP_<server>_ENV      = <json>     stdio: env overlay for the child (tokens)
//   PLURNK_EXECS_MCP_<server>_HEADERS  = <json>     http:  request headers (auth)
//   PLURNK_EXECS_MCP_INSTALL           = 0|1        daemon gate: may arbitrary MCP
//                                             tooling be ADDED at runtime (the
//                                             /mcp hotload route)? Default off.
//
// Servers case-fold (PLURNK_EXECS_MCP_github === PLURNK_EXECS_MCP_GITHUB); two keys folding
// to the same server is fail-hard, exactly as model aliases are. `_ENV` /
// `_HEADERS` are reserved companion suffixes and `INSTALL` is a reserved control
// key, so a server can't be named to end in those or to be named `install`.
// This module is SDK-free — it only parses the environment, so the runtimes
// hook that imports it pulls no transport code at discovery time.

const PREFIX = "PLURNK_EXECS_MCP_";
const ENV_SUFFIX = "_env";
const HEADERS_SUFFIX = "_headers";

// Reserved control keys in the PLURNK_EXECS_MCP_* namespace — daemon switches, never
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

// One pass over the environment, partitioning `PLURNK_EXECS_MCP_*` into server targets
// and their `_ENV` / `_HEADERS` companions (all keyed by the case-folded server
// name). The prefix is fixed upper-case; only the suffix case varies, so the
// user's `PLURNK_EXECS_MCP_github` and a conventional `PLURNK_EXECS_MCP_GITHUB` both resolve.
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
// PLURNK_EXECS_MCP_INSTALL=1. Mirrors the trust-gate truthiness convention.
export const installAllowed = (env: NodeJS.ProcessEnv = process.env): boolean => {
    const gate = env.PLURNK_EXECS_MCP_INSTALL;
    return !(gate === undefined || gate === "" || gate === "0");
};

// Runtime-injected servers — the `/mcp` hotload route (plurnk-execs#13). The
// consumer gates registration with installAllowed() then calls registerServer();
// the injected set supplements env discovery so the executor's run()/probe()
// resolve the new tag. Env-declared servers always take precedence (the locked
// #240 rule: they're operator-vetted, never shadowed by a runtime add).
const injected = new Map<string, ServerConfig>();

// Register a runtime-injected server under a tag. The consumer's route MUST gate
// this behind installAllowed(); the executor re-checks at connect (isInjected).
export const registerServer = (name: string, config: ServerConfig): void => {
    const key = name.toLowerCase();
    if (CONTROL_KEYS.has(key)) throw new Error(`"${key}" is a reserved control key, not a server name`);
    injected.set(key, config);
};

// Whether `name` resolves to a runtime-injected server that env does NOT also
// claim — the executor gates exactly these on installAllowed() at connect
// (defense in depth behind the consumer's route gate). An env-declared server is
// never gated, even if a name was also injected, since env always wins.
export const isInjected = (name: string, env: NodeJS.ProcessEnv = process.env): boolean => {
    const key = name.toLowerCase();
    return !parse(env).targets.has(key) && injected.has(key);
};

// Parse a server target string into transport config. An http(s) URL → http;
// anything else → a stdio command line. Shared by env resolution and the hotload
// route, which turns an operator-supplied `<address>` into a ServerConfig.
export const parseTarget = (
    target: string,
    { env, headers }: { env?: Record<string, string>; headers?: Record<string, string> } = {},
): ServerConfig => {
    if (/^https?:\/\//i.test(target)) return { transport: "http", url: target, headers };
    const [command, ...args] = target.split(/\s+/);
    return { transport: "stdio", command, args, env };
};

// The configured server names (= the tags), case-folded and sorted: env-declared
// unioned with runtime-injected. Empty when none are set.
export const serverNames = (env: NodeJS.ProcessEnv = process.env): string[] =>
    [...new Set([...parse(env).targets.keys(), ...injected.keys()])].sort();

// Runtime-injected Authorization headers — the OAuth bearer from completeAuth().
// Merged over a server's env `_HEADERS` by serverConfig (http only). This is the
// injection path for an ENV-declared server: registerServer creates a *new*
// injected server, but an env server always wins over an injected rival, so a
// token has to overlay the resolved config, not register beside it
// (plurnk-execs-mcp#1). Mcp.install() sets these and evicts the cached client.
const authHeaders = new Map<string, Record<string, string>>();

export const setAuthHeaders = (name: string, headers: Record<string, string>): void => {
    authHeaders.set(name.toLowerCase(), headers);
};

// Resolve a server's transport config. Env-declared wins; a runtime-injected
// server resolves only when no env target claims the name. null when neither
// does. Runtime-injected auth headers overlay an http config's own headers.
export const serverConfig = (name: string, env: NodeJS.ProcessEnv = process.env): ServerConfig | null => {
    const { targets, envs, headers } = parse(env);
    const key = name.toLowerCase();
    const target = targets.get(key);
    const cfg = target !== undefined
        ? parseTarget(target, {
            env: jsonRecord(envs.get(key), `${PREFIX}${key.toUpperCase()}_ENV`),
            headers: jsonRecord(headers.get(key), `${PREFIX}${key.toUpperCase()}_HEADERS`),
        })
        : injected.get(key) ?? null;
    const overlay = authHeaders.get(key);
    if (cfg !== null && cfg.transport === "http" && overlay !== undefined) {
        cfg.headers = { ...cfg.headers, ...overlay };
    }
    return cfg;
};
