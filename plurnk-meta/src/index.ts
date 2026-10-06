// The metaproject layer's membership slice — the mechanics every discovery
// surface shares ({§extension-discovery} / {§operator-config-env-defaults}):
//   - declaresKind:      the ONE package → kind representation.
//   - readManifest:       the ONE extension declaration read: a kind's manifest, or null for
//                         anything that is not a package of that kind. Field
//                         validation past the kind claim is the caller's.
//   - Knob:               the ONE environment reader: the panel's value by name, or a
//                         crash by name ({§env-knob}).
//   - ErrorDetail:        the ONE diagnostic-preview bound, per package knob
//                         ({§error-detail-bound}).
//   - isTrusted:          THE trust rule. One implementation; a second definition
//                         of membership trust anywhere in the packages is a bug.
//   - normalizeAttribution:
//                         one package declaration → one validated tag list.
//   - packageDirs:        scope-agnostic, symlink-aware enumeration of the Node
//                         resolution chain. Nearest package wins when npm splits
//                         a deployment across nested node_modules directories.
//                         Returns candidates; ORDERING AND FILTERING ARE THE
//                         CALLER'S POLICY.
//   - nearestNodeModules: deployment-root resolution — walk up to the nearest
//                         node_modules holding the ecosystem (witness: @plurnk).
//                         Registry installs hit the install root; workspace
//                         checkouts escape node_modules via symlink realpaths and
//                         land on the monorepo root's. Null when nothing is found;
//                         the fallback is the caller's policy.

import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ConfigurationError from "./ConfigurationError.ts";
import { AgentPluginFiles, isObject } from "./AgentPlugin.ts";

export { default as Knob } from "./Knob.ts";
export { default as ConfigurationError } from "./ConfigurationError.ts";
export { default as ResourceEnvironment } from "./ResourceEnvironment.ts";
export { default as ErrorDetail } from "./ErrorDetail.ts";

export interface PackageCandidate {
    dir: string;
    name: string;
}

const EXTENSION_KINDS = ["exec", "mimetype", "provider", "scheme", "http-materializer", "module"] as const;
export type ExtensionKind = typeof EXTENSION_KINDS[number];

// {§extension-manifest-read} — one extension declaration, projected to its owning kind.
export interface ExtensionManifest {
    readonly manifestPath: string;
    // `name` when it is a non-empty string; the caller decides what an unnamed package is.
    readonly packageName: string | null;
    readonly plurnk: Record<string, unknown>;
}

// Authored package.json shape retained only where a published kind descriptor
// requires that projection. Discovery and consumers exchange ExtensionAttribution.
export type ExtensionAttributionDeclaration = string | string[];
export type ExtensionAttribution = readonly string[];
export type PackageAttributions = ReadonlyMap<string, ExtensionAttribution>;

export interface ExtensionAttributionContext {
    readonly workspaceId: string;
    readonly workerId: string;
    readonly loop: number;
    readonly turn: number;
    readonly attempt: number;
}

export interface ExtensionAttributionSource {
    attributions?(context: ExtensionAttributionContext): ExtensionAttributionDeclaration | null | undefined;
}

const REFERENCE_TEACHING = Object.freeze({
    worker: Object.freeze({ source: "docs/worker.md", scheme: "worker" }),
    delegation: Object.freeze({ source: "docs/delegation.md", scheme: "worker" }),
    pattern: Object.freeze({ source: "docs/pattern.md", scheme: null }),
} as const);

// {§teaching-corpus} — the authored package membership is one exported fact;
// consumers decide when and where each required source is projected.
export { observed, observedSync } from "./observe.ts";

export const TEACHING_CORPUS = Object.freeze({
    policy: "POLICY.md",
    recap: "recap.md",
    skill: "skills/plurnk/SKILL.md",
    docs: REFERENCE_TEACHING,

} as const);

export type TeachingCorpusSource =
    | typeof TEACHING_CORPUS.policy
    | typeof TEACHING_CORPUS.recap
    | typeof TEACHING_CORPUS.skill
    | (typeof TEACHING_CORPUS.docs)[keyof typeof TEACHING_CORPUS.docs]["source"];


const TRUSTED_ONLY = "PLURNK_EXTENSIONS_TRUSTED_ONLY";

// {§extension-trust-boundary} — a renamed setting's old name fails hard and names its successor.
const shedRenamed = (env: Record<string, string | undefined>, oldName: string, newName: string): void => {
    if (env[oldName] !== undefined) throw new ConfigurationError(oldName, `${oldName} is retired: ${newName} is the extension trust setting.`);
};
const RESERVED_ATTRIBUTION_PREFIX = "@plurnk/";
const EMPTY_ATTRIBUTION: ExtensionAttribution = Object.freeze([] as string[]);

export default class Meta {
    static #shippedTrust: string | undefined;

    static declaresKind(manifest: unknown, kind: ExtensionKind): boolean {
        if (typeof manifest !== "object" || manifest === null) return false;
        return (manifest as { kind?: unknown }).kind === kind;
    }

    // {§extension-manifest-read} — null for a missing or malformed package.json, a non-object,
    // no `plurnk` object, or another kind: none of those is a package of this kind, and
    // discovery skips them without a word. An abort is the caller's contract and surfaces.
    static async readManifest(dir: string, kind?: ExtensionKind, { signal }: { signal?: AbortSignal } = {}): Promise<ExtensionManifest | null> {
        const pluginPath = path.join(dir, "plugin.json");
        let plugin: Awaited<ReturnType<typeof AgentPluginFiles.manifest>>;
        try {
            plugin = await AgentPluginFiles.manifest(dir, { signal });
        } catch (cause) {
            signal?.throwIfAborted();
            if (cause instanceof Error && cause.name === "AbortError") throw cause;
            throw new ConfigurationError(pluginPath, `${pluginPath}: plugin.json could not be read.`, { cause });
        }
        const packageRecord = await Meta.#packageRecord(dir, signal);
        if (plugin !== null) {
            if ("rejected" in plugin) {
                throw new ConfigurationError(pluginPath, `${pluginPath}: ${plugin.rejected.message}.`);
            }
            if (isObject(packageRecord?.plurnk) && packageRecord.plurnk.kind !== undefined) {
                throw new ConfigurationError(pluginPath, `${pluginPath}: native capabilities must not also be declared in package.json#plurnk.`);
            }
            const native = plugin.manifest.extensions?.["ai.plurnk"];
            if (native === undefined) return null;
            if (!EXTENSION_KINDS.some((kind) => Meta.declaresKind(native, kind))) {
                throw new ConfigurationError(pluginPath, `${pluginPath}: extensions.ai.plurnk.kind must name one extension kind.`);
            }
            if (kind !== undefined && !Meta.declaresKind(native, kind)) return null;
            const packageName = typeof packageRecord?.name === "string" && packageRecord.name.length > 0
                ? packageRecord.name : plugin.manifest.name;
            return { manifestPath: pluginPath, packageName, plurnk: native };
        }
        if (packageRecord === null) return null;
        const plurnk = packageRecord.plurnk;
        if (!isObject(plurnk) || !(kind === undefined
            ? EXTENSION_KINDS.some((kind) => Meta.declaresKind(plurnk, kind))
            : Meta.declaresKind(plurnk, kind))) return null;
        const packageName = typeof packageRecord.name === "string" && packageRecord.name.length > 0 ? packageRecord.name : null;
        return { manifestPath: path.join(dir, "package.json"), packageName, plurnk };
    }

    // {§extension-manifest-read} Framework loaders resolve their own file declarations through this boundary.
    static async moduleFile(manifest: ExtensionManifest, relative: string): Promise<string> {
        const dir = path.dirname(manifest.manifestPath);
        if (path.basename(manifest.manifestPath) !== "plugin.json") return path.resolve(dir, relative);
        const root = await AgentPluginFiles.resolved(dir);
        if (root === null) {
            throw new ConfigurationError(manifest.manifestPath, `${manifest.manifestPath}: plugin root is unavailable.`);
        }
        const location = path.resolve(root, relative);
        if (!relative.startsWith("ai.plurnk/")
            || !AgentPluginFiles.inside(path.join(root, "ai.plurnk"), location)) {
            throw new ConfigurationError(manifest.manifestPath, `${manifest.manifestPath}: native module must be beneath ai.plurnk/.`);
        }
        if (!await AgentPluginFiles.contained(root, location)) {
            throw new ConfigurationError(manifest.manifestPath, `${manifest.manifestPath}: native module resolves outside the plugin root.`);
        }
        return location;
    }

    static async #packageRecord(dir: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
        let raw: string;
        try {
            raw = await readFile(path.join(dir, "package.json"), { encoding: "utf8", signal });
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            return null;
        }
        let pkg: unknown;
        try {
            pkg = JSON.parse(raw);
        } catch {
            return null;
        }
        return isObject(pkg) ? pkg : null;
    }

    // {§operator-config-only-home} — the trust gate is asked while the floor is still being
    // assembled (it decides whose panel joins it), so an unset key cannot mean "the panel said
    // nothing". This package owns the key, so it reads its own panel: the operator's environment
    // first, then the shipped declaration. A value in code would outrank both.
    static #panelTrust(): string {
        if (Meta.#shippedTrust === undefined) {
            const panel = path.join(fileURLToPath(new URL("..", import.meta.url)), ".env.defaults");
            const declared = (parseEnv(readFileSync(panel, "utf8")) as Record<string, string>)[TRUSTED_ONLY];
            if (declared === undefined) {
                throw new Error(`@plurnk/plurnk-meta: ${TRUSTED_ONLY} is missing from its own .env.defaults — the shipped floor is not optional.`);
            }
            Meta.#shippedTrust = declared;
        }
        return Meta.#shippedTrust;
    }

    // "" / "0" → gate OFF: everything installed is trusted.
    // any other value  → gate ON: @plurnk/* always trusted, plus a comma-separated
    //                    allowlist; "1" (naming no real package) = on, zero third-party.
    static isTrusted(packageName: string, env: Record<string, string | undefined> = process.env): boolean {
        shedRenamed(env, "PLURNK_PLUGINS_TRUSTED_ONLY", TRUSTED_ONLY); // lexicon-allow: the shed names the retired setting
        const stated = env[TRUSTED_ONLY];
        const value = (stated === undefined ? Meta.#panelTrust() : stated).trim();
        if (value === "" || value === "0") return true;
        if (packageName.startsWith("@plurnk/")) return true;
        return value.split(",").map((s) => s.trim()).includes(packageName);
    }

    static normalizeAttribution(raw: unknown, packageName: string): ExtensionAttribution {
        if (raw === undefined || raw === null) return EMPTY_ATTRIBUTION;
        const values = Array.isArray(raw) ? raw : [raw];
        const firstParty = packageName.startsWith(RESERVED_ATTRIBUTION_PREFIX);
        const tags = values.map((value) => {
            if (typeof value !== "string" || value.length === 0) {
                throw new Error(`extension '${packageName}': plurnk.attribution must be a non-empty string or string[]`);
            }
            if (value.startsWith(RESERVED_ATTRIBUTION_PREFIX) && !firstParty) {
                throw new Error(
                    `extension '${packageName}': '${RESERVED_ATTRIBUTION_PREFIX}' is reserved for `
                    + `${RESERVED_ATTRIBUTION_PREFIX}-scoped packages — '${packageName}' cannot claim '${value}'`,
                );
            }
            return value;
        });
        return Object.freeze(tags);
    }

    // {§extension-attribution} — one synchronous runtime pull with the same shape
    // and sole namespace reservation as the static declaration. Tags remain
    // opaque; this boundary validates structure, not meaning.
    static runtimeAttribution(
        source: unknown,
        context: ExtensionAttributionContext,
        packageName: string,
    ): ExtensionAttribution {
        if (source === null || source === undefined) return EMPTY_ATTRIBUTION;
        const hook = (source as { attributions?: unknown }).attributions;
        if (hook === undefined) return EMPTY_ATTRIBUTION;
        if (typeof hook !== "function") {
            throw new TypeError(`extension '${packageName}': attributions must be a function when present`);
        }
        let raw: unknown;
        try {
            raw = hook.call(source, context);
        } catch (cause) {
            throw new Error(`extension '${packageName}': attributions() failed`, { cause });
        }
        return Meta.normalizeAttribution(raw, packageName);
    }

    static composeAttributions(...lists: readonly ExtensionAttribution[]): ExtensionAttribution {
        if (lists.length === 0) return EMPTY_ATTRIBUTION;
        const tags = [...new Set(lists.flat())].toSorted();
        return tags.length === 0 ? EMPTY_ATTRIBUTION : Object.freeze(tags);
    }

    static async #packageDirsOne(nodeModulesDir: string): Promise<PackageCandidate[]> {
        let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
        try {
            entries = await readdir(nodeModulesDir, { withFileTypes: true });
        } catch {
            return [];
        }
        const candidates: PackageCandidate[] = [];
        for (const entry of entries) {
            if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
            if (entry.name.startsWith("@")) {
                const scopeDir = path.join(nodeModulesDir, entry.name);
                let scoped: typeof entries;
                try {
                    scoped = await readdir(scopeDir, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const s of scoped) {
                    if (s.isDirectory() || s.isSymbolicLink()) candidates.push({ dir: path.join(scopeDir, s.name), name: `${entry.name}/${s.name}` });
                }
            } else {
                candidates.push({ dir: path.join(nodeModulesDir, entry.name), name: entry.name });
            }
        }
        return candidates;
    }

    // Every package resolvable from nodeModulesDir — unscoped (`name`) and scoped
    // (`@scope/name`) alike. npm may place one peer set beside a workspace package
    // and the rest at an ancestor; Node resolves through both, so discovery does too.
    // Nearest wins by package name. Symlinks are included; dot entries are skipped.
    static async packageDirs(nodeModulesDir: string): Promise<PackageCandidate[]> {
        const candidates: PackageCandidate[] = [];
        const seenNames = new Set<string>();
        const seenDirs = new Set<string>();
        let dir = path.resolve(nodeModulesDir);
        while (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            for (const candidate of await Meta.#packageDirsOne(dir)) {
                if (seenNames.has(candidate.name)) continue;
                seenNames.add(candidate.name);
                candidates.push(candidate);
            }
            let cursor = path.dirname(dir);
            let next: string | null = null;
            while (true) {
                const parent = path.dirname(cursor);
                if (parent === cursor) break;
                cursor = parent;
                const candidate = path.basename(cursor) === "node_modules" ? cursor : path.join(cursor, "node_modules");
                if (!seenDirs.has(candidate) && existsSync(candidate)) { next = candidate; break; }
            }
            if (next === null) break;
            dir = next;
        }
        return candidates;
    }

    static nearestNodeModules(fromDir: string): string | null {
        let dir = path.resolve(fromDir);
        while (true) {
            const candidate = path.join(dir, "node_modules");
            if (existsSync(path.join(candidate, "@plurnk"))) return candidate;
            const parent = path.dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    }
}
