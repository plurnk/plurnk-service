// {§mcp-registry-discovery} — `discover` searches the official MCP Registry (API v0.1). A listed server's
// stdio packages become self-contained standard entries and its Streamable HTTP remotes become URL
// entries; anything that needs a person's input first (a template variable, a required argument with
// no value) has no entry. Nothing here installs, launches, or connects.
import type { McpStdioServerDefinition, McpStreamableHttpServerDefinition } from "@plurnk/plurnk-contracts";

type McpServerEntry = Omit<McpStdioServerDefinition, "name"> | Omit<McpStreamableHttpServerDefinition, "name">;

interface Argument {
    readonly type?: unknown;
    readonly name?: unknown;
    readonly value?: unknown;
    readonly default?: unknown;
    readonly isRequired?: unknown;
}

interface KeyValue {
    readonly name?: unknown;
    readonly value?: unknown;
    readonly default?: unknown;
    readonly isRequired?: unknown;
    readonly isSecret?: unknown;
}

interface Package {
    readonly registryType?: unknown;
    readonly identifier?: unknown;
    readonly version?: unknown;
    readonly runtimeHint?: unknown;
    readonly transport?: { readonly type?: unknown };
    readonly runtimeArguments?: readonly Argument[];
    readonly packageArguments?: readonly Argument[];
    readonly environmentVariables?: readonly KeyValue[];
}

interface Remote {
    readonly type?: unknown;
    readonly url?: unknown;
    readonly headers?: readonly KeyValue[];
}

export interface RegistryServer {
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly packages?: readonly Package[];
    readonly remotes?: readonly Remote[];
}

export interface RegistryEntry {
    readonly alias: string;
    readonly summary: string;
    readonly entry: McpServerEntry;
    readonly reference: string;
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const templated = (value: string): boolean => /\{[^}]*\}/u.test(value);

// The command each registry type runs through, as the registry's own examples launch it; a
// non-interactive flag keeps a first-run install prompt off the protocol's stdin.
const RUNNERS: Readonly<Record<string, { readonly command: string; readonly flags: readonly string[]; readonly reference: (identifier: string, version: string) => string }>> = {
    npm: { command: "npx", flags: ["-y"], reference: (identifier, version) => `${identifier}@${version}` },
    pypi: { command: "uvx", flags: [], reference: (identifier, version) => `${identifier}@${version}` },
    nuget: { command: "dnx", flags: [], reference: (identifier, version) => `${identifier}@${version}` },
    oci: { command: "docker", flags: ["run", "-i", "--rm"], reference: (identifier) => identifier },
};

// Positional values in order, named ones as `--name value`; null when one needs a person's input.
const argv = (args: readonly Argument[] | undefined): string[] | null => {
    const out: string[] = [];
    for (const arg of args ?? []) {
        const value = text(arg.value) ?? text(arg.default);
        if (value !== undefined && templated(value)) return null;
        if (value === undefined) {
            if (arg.isRequired === true) return null;
            continue;
        }
        if (arg.type === "named") {
            const name = text(arg.name);
            if (name === undefined) return null;
            out.push(name, value);
        } else {
            out.push(value);
        }
    }
    return out;
};

// The server's registry name's last segment, as plurnk spells a server.
export const aliasOf = (registryName: string): string | null => {
    const alias = (registryName.split("/").at(-1) ?? "")
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]+/gu, "-")
        .replace(/^[^a-z]+/u, "")
        .replace(/-+$/u, "");
    return alias.length === 0 ? null : alias;
};

const packageEntry = (pkg: Package): { entry: McpServerEntry; launch: string; needs: string[] } | null => {
    const registryType = text(pkg.registryType);
    const identifier = text(pkg.identifier);
    const version = text(pkg.version);
    const runner = registryType === undefined ? undefined : RUNNERS[registryType];
    if (runner === undefined || identifier === undefined || (version === undefined && registryType !== "oci")) return null;
    if (pkg.transport?.type !== "stdio") return null;
    const runtime = argv(pkg.runtimeArguments);
    const packaged = argv(pkg.packageArguments);
    if (runtime === null || packaged === null) return null;
    const variables = (pkg.environmentVariables ?? []).flatMap((variable) => text(variable.name) ?? []);
    const command = text(pkg.runtimeHint) ?? runner.command;
    const flags = runner.flags.filter((flag) => !runtime.includes(flag));
    // A container inherits nothing: each declared variable passes through from the launch environment.
    const passed = registryType === "oci" ? variables.flatMap((name) => ["-e", name]) : [];
    const args = [...flags, ...passed, ...runtime, runner.reference(identifier, version ?? ""), ...packaged];
    const needs = (pkg.environmentVariables ?? [])
        .filter((variable) => variable.isRequired === true && text(variable.default) === undefined)
        .flatMap((variable) => text(variable.name) ?? []);
    return { entry: { type: "stdio", command, args }, launch: [command, ...args].join(" "), needs };
};

const remoteEntry = (remote: Remote): { entry: McpServerEntry; launch: string; needs: string[] } | null => {
    const url = text(remote.url);
    if (remote.type !== "streamable-http" || url === undefined || templated(url)) return null;
    const headers: Record<string, string> = {};
    const needs: string[] = [];
    for (const header of remote.headers ?? []) {
        const name = text(header.name);
        if (name === undefined) return null;
        const value = header.isSecret === true ? undefined : text(header.value) ?? text(header.default);
        if (value !== undefined && templated(value)) return null;
        if (value !== undefined) headers[name] = value;
        else if (header.isRequired === true) needs.push(`the ${name} header`);
    }
    return {
        entry: { type: "streamable-http", url, ...(Object.keys(headers).length === 0 ? {} : { headers }) },
        launch: url,
        needs,
    };
};

export const registryEntries = (server: RegistryServer): RegistryEntry[] => {
    const alias = aliasOf(server.name);
    if (alias === null) return [];
    const purpose = server.description?.trim() ?? "";
    return [...(server.packages ?? []).map(packageEntry), ...(server.remotes ?? []).map(remoteEntry)]
        .flatMap((found) => found === null ? [] : [{
            alias,
            summary: [purpose, found.launch, found.needs.length === 0 ? "" : `Needs ${found.needs.join(", ")}.`]
                .filter((part) => part.length > 0).join(" — "),
            entry: found.entry,
            reference: `${server.name}@${server.version}`,
        }]);
};

export class RegistryError extends Error {
    readonly status: number | null;

    constructor(message: string, status: number | null, options?: ErrorOptions) {
        super(message, options);
        this.name = "RegistryError";
        this.status = status;
    }
}

const isServer = (value: unknown): value is RegistryServer => {
    if (typeof value !== "object" || value === null) return false;
    const server = value as Record<string, unknown>;
    return typeof server.name === "string" && typeof server.version === "string";
};

// One page of the latest version of every server whose name matches the query.
export const searchRegistry = async (
    { url, query, limit, timeoutMs }: { readonly url: string; readonly query: string; readonly limit: number; readonly timeoutMs: number },
): Promise<RegistryServer[]> => {
    const endpoint = new URL("v0.1/servers", url.endsWith("/") ? url : `${url}/`);
    endpoint.searchParams.set("search", query);
    endpoint.searchParams.set("version", "latest");
    endpoint.searchParams.set("limit", String(limit));
    let response: Response;
    try {
        response = await fetch(endpoint, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
        throw new RegistryError(`The MCP Registry at ${endpoint.origin} could not be reached.`, null, { cause });
    }
    if (!response.ok) throw new RegistryError(`The MCP Registry at ${endpoint.origin} answered ${response.status}.`, response.status);
    let body: unknown;
    try {
        body = await response.json();
    } catch (cause) {
        throw new RegistryError(`The MCP Registry at ${endpoint.origin} answered with malformed JSON.`, response.status, { cause });
    }
    const listed = (body as { servers?: unknown } | null)?.servers;
    if (!Array.isArray(listed)) throw new RegistryError(`The MCP Registry at ${endpoint.origin} answered without a server list.`, response.status);
    return listed.flatMap((item) => {
        const server = (item as { server?: unknown } | null)?.server;
        return isServer(server) ? [server] : [];
    });
};
