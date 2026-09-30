import { MCP_SCHEMA, isObject, schemaVersion } from "./AgentPlugins.ts";
import type { Finding } from "./PluginReport.ts";

export interface StdioServer {
    readonly type: "stdio";
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
}

export interface RemoteServer {
    readonly type: "streamable-http" | "sse";
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
}

export type McpServerEntry = StdioServer | RemoteServer;

export interface ServerFinding extends Finding {
    readonly server: string;
}

export type McpConfigurationResult =
    | { readonly servers: ReadonlyMap<string, McpServerEntry>; readonly skipped: readonly ServerFinding[] }
    | { readonly disabled: Finding };

const VARIANTS: Readonly<Record<string, ReadonlySet<string>>> = {
    stdio: new Set(["type", "command", "args", "env", "cwd"]),
    "streamable-http": new Set(["type", "url", "headers"]),
    sse: new Set(["type", "url", "headers"]),
};
const WHITESPACE = /[\s\0]/u;
const CWD = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/u;
// oxlint-disable-next-line eslint/no-control-regex
const CONTROL = /[\s\0-\x1f\x7f]/u;
const USERINFO = /^[a-z][a-z0-9+.-]*:\/*[^/?#]*@/iu;
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/u;
const LOOPBACK_V4_MAPPED = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u;
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const FIELD_VALUE = /^(?:[\x21-\x7e\x80-\xff](?:[\t \x21-\x7e\x80-\xff]*[\x21-\x7e\x80-\xff])?)?$/u;

const strings = (value: unknown): value is Record<string, string> =>
    isObject(value) && Object.values(value).every((item) => typeof item === "string");
const problem = (section: string, message: string): Finding => ({ section, message });

// {§agent-plugins-mcp-entries} A stdio command is one token, bare or `./`, and is never expanded.
const stdioProblem = ({ command, args, env, cwd }: Record<string, unknown>): Finding | null => {
    if (typeof command !== "string" || command.length === 0) return problem("7.2.1", "command must be a non-empty string");
    if (WHITESPACE.test(command)) return problem("7.2.1", `command ${JSON.stringify(command)} is not a single executable token`);
    if (!command.startsWith("./") && (command.includes("/") || command === "." || command === "..")) {
        return problem("7.2.1", `command ${JSON.stringify(command)} is neither a bare executable name nor a ./ plugin path`);
    }
    if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === "string"))) return problem("7.2.1", "args must be an array of strings");
    if (env !== undefined && !strings(env)) return problem("7.2.1", "env must be an object of strings");
    const reserved = env === undefined ? undefined : Object.keys(env).find((key) => key === "PLUGIN_ROOT" || key === "PLUGIN_DATA");
    if (reserved !== undefined) return problem("9.2", `env must not set ${reserved}; the client supplies it`);
    if (cwd !== undefined && (typeof cwd !== "string" || !CWD.test(cwd))) {
        return problem("7.2.1", `cwd ${JSON.stringify(cwd)} is not rooted at ./, \${PLUGIN_ROOT}, or \${PLUGIN_DATA}`);
    }
    return null;
};

const isLoopback = (hostname: string): boolean =>
    hostname === "localhost" || LOOPBACK_V4.test(hostname) || hostname === "[::1]" || LOOPBACK_V4_MAPPED.test(hostname);

const urlProblem = (raw: string): string | null => {
    if (CONTROL.test(raw) || !URL.canParse(raw)) return `url ${JSON.stringify(raw)} is not an absolute URL`;
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return `url scheme ${url.protocol} is not http or https`;
    if (url.username !== "" || url.password !== "" || USERINFO.test(raw)) return "url must not contain user information";
    if (raw.includes("#")) return "url must not contain a fragment";
    if (url.protocol === "http:" && !isLoopback(url.hostname)) return `non-loopback endpoint ${url.host} must use https`;
    return null;
};

// {§agent-plugins-mcp-entries} A remote endpoint is an absolute URL, HTTPS off loopback, with literal headers.
const remoteProblem = ({ url, headers }: Record<string, unknown>): Finding | null => {
    if (typeof url !== "string" || url.length === 0) return problem("7.2.1", "url must be a non-empty string");
    const invalid = urlProblem(url);
    if (invalid !== null) return problem("7.2.1", invalid);
    if (headers === undefined) return null;
    if (!strings(headers)) return problem("7.2.1", "headers must be an object of strings");
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(headers as Record<string, string>)) {
        if (!FIELD_NAME.test(name)) return problem("7.2.1", `header name ${JSON.stringify(name)} is not a valid HTTP field name`);
        if (!FIELD_VALUE.test(value)) return problem("7.2.1", `header ${name} has an invalid HTTP field value`);
        if (seen.has(name.toLowerCase())) return problem("7.2.1", `header ${name} appears more than once under different casing`);
        seen.add(name.toLowerCase());
    }
    return null;
};

const entryProblem = (entry: unknown): Finding | null => {
    if (!isObject(entry)) return problem("7.2.1", "a server configuration must be an object");
    const { type } = entry;
    if (typeof type !== "string" || !Object.hasOwn(VARIANTS, type)) {
        return problem("7.2.1", `type ${JSON.stringify(type)} is not stdio, streamable-http, or sse`);
    }
    const foreign = Object.keys(entry).find((key) => !VARIANTS[type]!.has(key));
    if (foreign !== undefined) return problem("7.2.1", `field ${JSON.stringify(foreign)} does not belong to the ${type} variant`);
    return type === "stdio" ? stdioProblem(entry) : remoteProblem(entry);
};

// {§agent-plugins-components} A top-level fault disables MCP for the plugin; an entry fault skips that entry alone.
export const validateMcpConfiguration = (value: unknown): McpConfigurationResult => {
    if (!isObject(value)) return { disabled: problem("7.2.1", "mcp.json must contain a top-level JSON object") };
    const { $schema, mcpServers } = value;
    if (typeof $schema !== "string") return { disabled: problem("7.2.1", "required field $schema is missing or not a string") };
    if ($schema !== MCP_SCHEMA) {
        const version = schemaVersion($schema, "mcp");
        return {
            disabled: version === null
                ? problem("7.2.1", `$schema ${JSON.stringify($schema)} is not a canonical Agent Plugins MCP identifier`)
                : problem("10.1", `mcp.json targets Agent Plugins ${version}, but plugin.json targets 1.0.0`),
        };
    }
    const extra = Object.keys(value).find((key) => key !== "$schema" && key !== "mcpServers");
    if (extra !== undefined) return { disabled: problem("7.2.1", `unknown top-level field ${JSON.stringify(extra)}`) };
    if (!isObject(mcpServers)) return { disabled: problem("7.2.1", "required field mcpServers is missing or not an object") };
    const servers = new Map<string, McpServerEntry>();
    const skipped: ServerFinding[] = [];
    for (const [server, entry] of Object.entries(mcpServers)) {
        const found = entryProblem(entry);
        if (found === null) servers.set(server, entry as unknown as McpServerEntry);
        else skipped.push({ server, ...found });
    }
    return { servers, skipped };
};
