import { PLUGIN_SCHEMA, isObject, schemaVersion } from "./AgentPlugins.ts";
import type { Finding } from "./PluginReport.ts";

export interface PluginAuthor {
    readonly name?: string;
    readonly email?: string;
    readonly url?: string;
}

// {§agent-plugins-manifest} The permitted fields of a 1.0.0 manifest; unknown fields never survive validation.
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

// {§agent-plugins-manifest} Unknown fields and a non-object `extensions` are the only non-fatal violations.
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
    return { manifest: manifest as unknown as PluginManifest, ignored };
};
