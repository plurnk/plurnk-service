// The metaproject layer's membership slice — the mechanics every discovery
// surface shares ({§extension-discovery} / {§operator-config-precedence}):
//   - declaresKind:      the ONE package → kind representation.
//   - readManifest:      the ONE first-party (@plurnk/*) extension declaration read:
//                        a kind's manifest from package.json#plurnk, or null for
//                        anything else. Field validation past the kind claim is
//                        the caller's.
//   - Knob:              the ONE environment reader: the panel's value by name, or a
//                        crash by name ({§env-knob}).
//   - ErrorDetail:       the ONE diagnostic-preview bound, per package knob
//                        ({§env-knob}).
//   - normalizeAttribution:
//                        one package declaration → one validated tag list.
//   - packageDirs:       scope-agnostic, symlink-aware enumeration of the Node
//                        resolution chain. Nearest package wins when npm splits
//                        a deployment across nested node_modules directories.
//                        Returns candidates; ORDERING AND FILTERING ARE THE
//                        CALLER'S POLICY.
//   - nearestNodeModules: deployment-root resolution — walk up to the nearest
//                        node_modules holding the ecosystem (witness: @plurnk).
//                        Registry installs hit the install root; workspace
//                        checkouts escape node_modules via symlink realpaths and
//                        land on the monorepo root's. Null when nothing is found;
//                        the fallback is the caller's policy.

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { isObject } from "./AgentPlugin.ts";

export { default as Knob } from "./Knob.ts";
export { default as ConfigurationError } from "./ConfigurationError.ts";
export { default as ResourceEnvironment } from "./ResourceEnvironment.ts";
export { default as ErrorDetail } from "./ErrorDetail.ts";
export { AgentPluginFiles } from "./AgentPlugin.ts";

export interface PackageCandidate {
    dir: string;
    name: string;
}

const EXTENSION_KINDS = ["exec", "mimetype", "provider", "scheme"] as const;
export type ExtensionKind = typeof EXTENSION_KINDS[number];

// {§extension-discovery} — one first-party (@plurnk/*) extension declaration, projected to its owning kind.
export interface ExtensionManifest {
    readonly manifestPath: string;
    readonly packageName: string;
    readonly plurnk: Record<string, unknown>;
}

export interface ScannedExtensionPackage {
    readonly dir: string;
    readonly manifestPath: string;
    readonly packageName: string;
    readonly plurnk: Record<string, unknown>;
    readonly attribution: ExtensionAttribution;
}

export interface ExtensionKindScan {
    readonly admitted: ScannedExtensionPackage[];
}

// Authored package.json shape retained only where a published kind descriptor
// requires that projection. Discovery and consumers exchange ExtensionAttribution.
export type ExtensionAttributionDeclaration = string | string[];
export type ExtensionAttribution = readonly string[];
export type PackageAttributions = ReadonlyMap<string, ExtensionAttribution>;

export interface ExtensionAttributionContext {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly loop: number;
    readonly turn: number;
    readonly attempt: number;
}

export interface ExtensionAttributionSource {
    attributions?(context: ExtensionAttributionContext): ExtensionAttributionDeclaration | null | undefined;
}

const REFERENCE_TEACHING = Object.freeze({
    session: Object.freeze({ source: "docs/session.md", scheme: "session" }),
    delegation: Object.freeze({ source: "docs/delegation.md", scheme: "session" }),
    pattern: Object.freeze({ source: "docs/pattern.md", scheme: null }),
} as const);

// {§teaching-corpus} — the authored package membership is one exported fact;
// consumers decide when and where each required source is projected.
export { observed, observedSync } from "./observe.ts";
export { outboundFetch, syncAmbientHttp } from "./outbound-http.ts";

export const TEACHING_CORPUS = Object.freeze({
    policy: "POLICY.md",
    skill: "skills/plurnk/SKILL.md",
    skillChapters: Object.freeze({
        extensibility: "skills/plurnk/extensibility.md",
        recipes: "skills/plurnk/recipes.md",
    } as const),
    docs: REFERENCE_TEACHING,
} as const);

export type TeachingCorpusSource =
    | typeof TEACHING_CORPUS.policy
    | typeof TEACHING_CORPUS.skill
    | (typeof TEACHING_CORPUS.skillChapters)[keyof typeof TEACHING_CORPUS.skillChapters]
    | (typeof TEACHING_CORPUS.docs)[keyof typeof TEACHING_CORPUS.docs]["source"];

const FIRST_PARTY_PREFIX = "@plurnk/";
const EMPTY_ATTRIBUTION: ExtensionAttribution = Object.freeze([] as string[]);

export default class Meta {
    static declaresKind(manifest: unknown, kind: ExtensionKind): boolean {
        if (typeof manifest !== "object" || manifest === null) return false;
        return (manifest as { kind?: unknown }).kind === kind;
    }

    // {§extension-discovery} — null for a missing or malformed package.json, a non-@plurnk/*
    // package, no `plurnk` object, or another kind: none of those is a first-party extension
    // package of this kind, and discovery skips them silently. An abort surfaces.
    static async readManifest(dir: string, kind?: ExtensionKind, { signal }: { signal?: AbortSignal } = {}): Promise<ExtensionManifest | null> {
        const packageRecord = await Meta.#packageRecord(dir, signal);
        if (packageRecord === null) return null;
        const packageName = packageRecord.name;
        if (typeof packageName !== "string" || !packageName.startsWith(FIRST_PARTY_PREFIX)) return null;
        const plurnk = packageRecord.plurnk;
        if (!isObject(plurnk) || !(kind === undefined
            ? EXTENSION_KINDS.some((candidate) => Meta.declaresKind(plurnk, candidate))
            : Meta.declaresKind(plurnk, kind))) return null;
        return { manifestPath: path.join(dir, "package.json"), packageName, plurnk };
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

    static normalizeAttribution(raw: unknown, packageName: string): ExtensionAttribution {
        if (raw === undefined || raw === null) return EMPTY_ATTRIBUTION;
        const values = Array.isArray(raw) ? raw : [raw];
        const firstParty = packageName.startsWith(FIRST_PARTY_PREFIX);
        const tags = values.map((value) => {
            if (typeof value !== "string" || value.length === 0) {
                throw new Error(`extension '${packageName}': plurnk.attribution must be a non-empty string or string[]`);
            }
            if (value.startsWith(FIRST_PARTY_PREFIX) && !firstParty) {
                throw new Error(
                    `extension '${packageName}': '${FIRST_PARTY_PREFIX}' is reserved for `
                    + `${FIRST_PARTY_PREFIX}-scoped packages — '${packageName}' cannot claim '${value}'`,
                );
            }
            return value;
        });
        return Object.freeze(tags);
    }

    // {§extension-discovery} — one synchronous runtime pull with the same shape
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

    static async resolvedPackageDirs(cwd: string): Promise<string[]> {
        const nm = Meta.nearestNodeModules(cwd) ?? path.join(path.resolve(cwd), "node_modules");
        const candidates = await Meta.packageDirs(nm);
        return candidates.filter((c) => c.name.startsWith(FIRST_PARTY_PREFIX)).map((c) => c.dir).toSorted();
    }

    static async scanKind(
        kind: ExtensionKind,
        options: {
            readonly cwd?: string;
            readonly packageDirs?: ReadonlyArray<string>;
            readonly signal?: AbortSignal;
        } = {},
    ): Promise<ExtensionKindScan> {
        const { cwd = process.cwd(), packageDirs, signal } = options;
        signal?.throwIfAborted();
        const dirs = packageDirs ?? await Meta.resolvedPackageDirs(cwd);
        const admitted: ScannedExtensionPackage[] = [];
        for (const dir of dirs) {
            signal?.throwIfAborted();
            const manifest = await Meta.readManifest(dir, kind, { signal });
            if (manifest === null) continue;
            const attribution = Meta.normalizeAttribution(manifest.plurnk.attribution, manifest.packageName);
            admitted.push({
                dir,
                manifestPath: manifest.manifestPath,
                packageName: manifest.packageName,
                plurnk: manifest.plurnk,
                attribution,
            });
        }
        return { admitted };
    }
}
