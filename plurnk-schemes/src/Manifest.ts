import type { SchemeAuthority, SchemeEntryInheritance, SchemeEntryOwner, SchemeManifest, WriterTier } from "./types.ts";

const WRITERS = new Set<WriterTier>(["model", "client", "_plurnk", "plugin"]);
const CATEGORIES = new Set<SchemeManifest["category"]>(["data", "logging", "control"]);
const AUTHORITIES = new Set<SchemeAuthority>(["namespace", "resource", "owner"]);
const ENTRY_OWNERS = new Set<SchemeEntryOwner>(["commons", "worker", "resolved"]);
const ENTRY_INHERITANCE = new Set<SchemeEntryInheritance>(["none", "snapshot", "rederive"]);
const MANIFEST_FIELD_NAMES = new Set<string>(Object.keys({
    name: true,
    authority: true,
    channels: true,
    defaultChannel: true,
    category: true,
    entryOwner: true,
    inherit: true,
    writableBy: true,
    volatile: true,
    modelVisible: true,
    folderScopes: true,
    textEditScopes: true,
    metadataModifier: true,
    lineAnchors: true,
    foldedByDefault: true,
    traits: true,
    example: true,
    documentation: true,
    glyph: true,
    storedScheme: true,
} satisfies Record<keyof SchemeManifest, true>));
const TRAIT = /^[a-z][a-z0-9-]*$/;

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
        const unknown = Object.keys(manifest).find((field) => !MANIFEST_FIELD_NAMES.has(field));
        if (unknown !== undefined) {
            throw new Error(`scheme '${name}' manifest has unknown field '${unknown}'`);
        }
        if (expectedName !== undefined && name !== expectedName) {
            throw new Error(`scheme identity mismatch: registered '${expectedName}', manifest declares '${name}'`);
        }
        if (manifest.authority !== undefined && !AUTHORITIES.has(manifest.authority as SchemeAuthority)) {
            throw new Error(`scheme '${name}' manifest.authority must be namespace, resource, or owner`);
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
        if (manifest.category === "data") {
            if (!ENTRY_OWNERS.has(manifest.entryOwner as SchemeEntryOwner)) {
                throw new Error(`data scheme '${name}' manifest.entryOwner must be commons, worker, or resolved`);
            }
            if (!ENTRY_INHERITANCE.has(manifest.inherit as SchemeEntryInheritance)) {
                throw new Error(`data scheme '${name}' manifest.inherit must be none, snapshot, or rederive`);
            }
            if (manifest.entryOwner === "resolved"
                && typeof (handler as { resolveEntryAddress?: unknown }).resolveEntryAddress !== "function") {
                throw new Error(`data scheme '${name}' with resolved entry ownership must implement resolveEntryAddress`);
            }
        } else if (manifest.entryOwner !== undefined || manifest.inherit !== undefined) {
            throw new Error(`non-data scheme '${name}' must not declare manifest.entryOwner or manifest.inherit`);
        }
        const writableBy = manifest.writableBy;
        if (!Array.isArray(writableBy)
            || !writableBy.every((writer): writer is WriterTier => typeof writer === "string" && WRITERS.has(writer as WriterTier))
            || new Set(writableBy).size !== writableBy.length) {
            throw new Error(`scheme '${name}' manifest.writableBy must contain unique writer tiers`);
        }
        Manifest.#boolean(manifest, "volatile");
        Manifest.#boolean(manifest, "modelVisible");
        for (const field of ["folderScopes", "textEditScopes", "metadataModifier", "lineAnchors", "foldedByDefault"] as const) Manifest.#optionalBoolean(manifest, field);
        for (const field of ["example", "documentation", "storedScheme"] as const) Manifest.#optionalString(manifest, field);
        Manifest.#optionalNonemptyString(manifest, "glyph");
        Manifest.#traits(manifest.traits, name);
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

    static #optionalNonemptyString(record: Record<string, unknown>, field: string): void {
        if (record[field] !== undefined && (typeof record[field] !== "string" || record[field].length === 0)) {
            throw new Error(`scheme manifest.${field} must be a non-empty string when present`);
        }
    }

    static #traits(value: unknown, name: string): void {
        if (value === undefined) return;
        if (!Array.isArray(value)
            || !value.every((trait) => typeof trait === "string" && TRAIT.test(trait))
            || new Set(value).size !== value.length) {
            throw new Error(`scheme '${name}' manifest.traits must contain unique lowercase trait names`);
        }
    }
}
