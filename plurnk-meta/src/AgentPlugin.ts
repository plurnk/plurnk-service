import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

// {§agent-plugins-roots} Shared inert Agent Plugins format primitives.
export const AGENT_PLUGINS_VERSION = "1.0.0";
export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

// A canonical identifier names its version; any other string is not an Agent Plugins identifier.
export const schemaVersion = (identifier: string, kind: "plugin" | "mcp"): string | null =>
    new RegExp(`^https://agent-plugins\\.org/schemas/([^/]+)/${kind}\\.schema\\.json$`, "u").exec(identifier)?.[1] ?? null;

// {§agent-plugins-expansion} One textual pass: text a replacement introduces is never scanned again.
export const expandPlaceholders = (value: string, { root, data }: { root: string; data: string }): string =>
    value.replaceAll(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/gu, (_placeholder, name: string) => (name === "PLUGIN_ROOT" ? root : data));

export const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

export interface Finding {
    readonly section: string;
    readonly message: string;
}

export interface PluginAuthor {
    readonly name?: string;
    readonly email?: string;
    readonly url?: string;
}

// {§agent-plugins-roots} The permitted fields of a 1.0.0 manifest; unknown fields never survive validation.
export interface PluginManifest {
    readonly $schema: typeof PLUGIN_SCHEMA;
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
    readonly author?: PluginAuthor;
    readonly homepage?: string;
    readonly repository?: string;
    readonly license?: string;
    readonly keywords?: readonly string[];
    readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export type ManifestResult =
    | { readonly manifest: PluginManifest; readonly ignored: readonly Finding[] }
    | { readonly rejected: Finding; readonly ignored: readonly Finding[] };

const FIELDS = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
const STRINGS = ["version", "description", "homepage", "repository", "license"] as const;
const AUTHOR = new Set(["name", "email", "url"]);
const NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

// {§agent-plugins-roots} Unknown fields and a non-object `extensions` are the only non-fatal violations.
export const validateManifest = (value: unknown): ManifestResult => {
    if (!isObject(value)) return { rejected: { section: "5.2", message: "plugin.json must contain a top-level JSON object" }, ignored: [] };
    const ignored: Finding[] = Object.keys(value).filter((key) => !FIELDS.has(key))
        .map((key) => ({ section: "5.2", message: `unknown top-level field ${JSON.stringify(key)} is ignored` }));
    const reject = (section: string, message: string): ManifestResult => ({ rejected: { section, message }, ignored });
    const { $schema, name, author, keywords, extensions } = value;
    if (typeof $schema !== "string") return reject("5.3", "required field $schema is missing or not a string");
    if ($schema !== PLUGIN_SCHEMA) {
        const version = schemaVersion($schema, "plugin");
        return reject("5.2", version === null
            ? `$schema ${JSON.stringify($schema)} is not a canonical Agent Plugins manifest identifier`
            : `Agent Plugins ${version} is not supported; this client implements 1.0.0`);
    }
    if (typeof name !== "string") return reject("5.3", "required field name is missing or not a string");
    if (name.length === 0 || name.length > 64 || !NAME.test(name)) return reject("5.5", `name ${JSON.stringify(name)} violates the plugin name constraints`);
    const nonString = STRINGS.find((field) => value[field] !== undefined && typeof value[field] !== "string");
    if (nonString !== undefined) return reject("5.4", `${nonString} must be a string`);
    if (author !== undefined) {
        if (!isObject(author)) return reject("5.4", "author must be an object");
        const invalid = Object.keys(author).find((key) => !AUTHOR.has(key) || typeof author[key] !== "string");
        if (invalid !== undefined) return reject("5.4", `author may hold only string name, email, and url; found ${JSON.stringify(invalid)}`);
    }
    if (keywords !== undefined && !(Array.isArray(keywords) && keywords.every((keyword) => typeof keyword === "string"))) {
        return reject("5.4", "keywords must be an array of strings");
    }
    if (extensions !== undefined && !isObject(extensions)) {
        ignored.push({ section: "8.1", message: "extensions is not an object and is ignored" });
    } else if (extensions !== undefined) {
        const member = Object.keys(extensions).find((namespace) => !isObject(extensions[namespace]));
        if (member !== undefined) return reject("8.1", `extensions member ${JSON.stringify(member)} must be an object`);
    }
    const manifest = Object.fromEntries(Object.entries(value)
        .filter(([key]) => FIELDS.has(key) && !(key === "extensions" && !isObject(extensions))));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the checks above are the manifest's validator; the kept fields are the ones it names
    return { manifest: manifest as unknown as PluginManifest, ignored };
};

// {§agent-plugins-containment} Shared by portable components and extension admission.
export class AgentPluginFiles {
    static errnoCode(cause: unknown): string | undefined {
        return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    }

    static inside(root: string, candidate: string): boolean {
        const path = relative(root, candidate);
        return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    }

    static async isFile(path: string): Promise<boolean> {
        try {
            return (await stat(path)).isFile();
        } catch (cause) {
            const code = AgentPluginFiles.errnoCode(cause);
            if (code === "ENOENT" || code === "ENOTDIR") return false;
            throw cause;
        }
    }

    static async resolved(path: string): Promise<string | null> {
        try {
            return await realpath(path);
        } catch (cause) {
            const code = AgentPluginFiles.errnoCode(cause);
            if (code === "ENOENT" || code === "ENOTDIR") return null;
            throw cause;
        }
    }

    static async contained(root: string, candidate: string): Promise<boolean> {
        if (!AgentPluginFiles.inside(root, candidate)) return false;
        const real = await AgentPluginFiles.resolved(candidate);
        if (real !== null) return AgentPluginFiles.inside(root, real);
        // A missing leaf can still escape through an existing symlinked parent.
        return candidate !== root && AgentPluginFiles.contained(root, dirname(candidate));
    }

    // null is absence, not an invalid manifest that permits another format to take its place.
    static async manifest(directory: string, { signal }: { signal?: AbortSignal } = {}): Promise<ManifestResult | null> {
        signal?.throwIfAborted();
        const authored = join(directory, "plugin.json");
        try { await lstat(authored); }
        catch (cause) {
            const code = AgentPluginFiles.errnoCode(cause);
            if (code === "ENOENT" || code === "ENOTDIR") return null;
            throw cause;
        }
        const root = await AgentPluginFiles.resolved(directory);
        if (root === null) return null;
        const location = await AgentPluginFiles.resolved(authored);
        if (location === null) {
            return { rejected: { section: "5.1", message: "plugin.json does not resolve to a regular file" }, ignored: [] };
        }
        if (!AgentPluginFiles.inside(root, location)) {
            return { rejected: { section: "4.1", message: "plugin.json resolves outside the plugin root" }, ignored: [] };
        }
        if (!(await stat(location)).isFile()) {
            return { rejected: { section: "5.1", message: "plugin.json is not a regular file" }, ignored: [] };
        }
        let value: unknown;
        try {
            value = JSON.parse(await readFile(location, { encoding: "utf8", signal }));
        } catch (cause) {
            if (!(cause instanceof SyntaxError)) throw cause;
            return { rejected: { section: "5.2", message: "plugin.json is not valid JSON" }, ignored: [] };
        }
        return validateManifest(value);
    }
}
