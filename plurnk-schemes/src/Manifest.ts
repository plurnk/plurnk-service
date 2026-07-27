import type { SchemeFlagAffinity, SchemeManifest, WriterTier } from "./types.ts";

const WRITERS = new Set<WriterTier>(["model", "client", "plurnk", "plugin"]);
const CATEGORIES = new Set<SchemeManifest["category"]>(["data", "logging", "control"]);
const SCOPES = new Set<SchemeManifest["scope"]>(["workspace", "worker"]);

export default class Manifest {
    static of(handler: unknown, expectedName?: string): SchemeManifest {
        if (typeof handler !== "object" || handler === null) {
            throw new Error("scheme handler must be an object");
        }
        const instance = handler as { manifest?: unknown; constructor?: { manifest?: unknown } };
        const value = instance.manifest ?? instance.constructor?.manifest;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error(`scheme '${expectedName ?? "unknown"}' must declare a static or instance manifest`);
        }
        const manifest = value as Record<string, unknown>;
        const name = Manifest.#string(manifest, "name");
        if (expectedName !== undefined && name !== expectedName) {
            throw new Error(`scheme identity mismatch: registered '${expectedName}', manifest declares '${name}'`);
        }
        const channels = manifest.channels;
        if (typeof channels !== "object" || channels === null || Array.isArray(channels)
            || !Object.entries(channels).every(([channel, mimetype]) => channel.length > 0
                && channel === channel.toLowerCase()
                && typeof mimetype === "string"
                && mimetype.length > 0)) {
            throw new Error(`scheme '${name}' manifest.channels must map lowercase channel names to non-empty mimetypes`);
        }
        const defaultChannel = Manifest.#string(manifest, "defaultChannel", true);
        if (Object.keys(channels).length > 0 && !Object.hasOwn(channels, defaultChannel)) {
            throw new Error(`scheme '${name}' manifest.defaultChannel '${defaultChannel}' is not declared in channels`);
        }
        if (!CATEGORIES.has(manifest.category as SchemeManifest["category"])) {
            throw new Error(`scheme '${name}' manifest.category must be data, logging, or control`);
        }
        if (!SCOPES.has(manifest.scope as SchemeManifest["scope"])) {
            throw new Error(`scheme '${name}' manifest.scope must be workspace or worker`);
        }
        const writableBy = manifest.writableBy;
        if (!Array.isArray(writableBy)
            || !writableBy.every((writer): writer is WriterTier => typeof writer === "string" && WRITERS.has(writer as WriterTier))
            || new Set(writableBy).size !== writableBy.length) {
            throw new Error(`scheme '${name}' manifest.writableBy must contain unique writer tiers`);
        }
        Manifest.#boolean(manifest, "volatile");
        Manifest.#boolean(manifest, "modelVisible");
        for (const field of ["folderScopes", "foldedByDefault"] as const) Manifest.#optionalBoolean(manifest, field);
        for (const field of ["example", "documentation", "glyph", "storedScheme"] as const) Manifest.#optionalString(manifest, field);
        Manifest.#flags(manifest.flags, name);
        return value as SchemeManifest;
    }

    static #string(record: Record<string, unknown>, field: string, emptyAllowed = false): string {
        const value = record[field];
        if (typeof value !== "string" || (!emptyAllowed && value.length === 0)) {
            throw new Error(`scheme manifest.${field} must be ${emptyAllowed ? "a string" : "a non-empty string"}`);
        }
        return value;
    }

    static #boolean(record: Record<string, unknown>, field: string): void {
        if (typeof record[field] !== "boolean") throw new Error(`scheme manifest.${field} must be boolean`);
    }

    static #optionalBoolean(record: Record<string, unknown>, field: string): void {
        if (record[field] !== undefined && typeof record[field] !== "boolean") {
            throw new Error(`scheme manifest.${field} must be boolean when present`);
        }
    }

    static #optionalString(record: Record<string, unknown>, field: string): void {
        if (record[field] !== undefined && typeof record[field] !== "string") {
            throw new Error(`scheme manifest.${field} must be a string when present`);
        }
    }

    static #flags(value: unknown, name: string): void {
        if (value === undefined) return;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error(`scheme '${name}' manifest.flags must be an object`);
        }
        const flags = value as Record<keyof SchemeFlagAffinity, unknown>;
        for (const field of ["excludedInAsk", "requiresWeb", "requiresInteraction", "proposes"] as const) {
            if (flags[field] !== undefined && typeof flags[field] !== "boolean") {
                throw new Error(`scheme '${name}' manifest.flags.${field} must be boolean`);
            }
        }
    }
}
