// Plugin discovery + loading for the daemon. SPEC §plugin-discovery.
//
// Boot-time scope-agnostic scan of node_modules — every scoped and unscoped
// package with a `plurnk` manifest field is a candidate, gated by the shared
// ecosystem trust rule (PLURNK_PLUGINS_TRUSTED_ONLY); dynamic-import them,
// register with the matching registry by kind. Alphabetical load order;
// collisions on (kind, name) fail-hard at registration time.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Meta from "@plurnk/plurnk-meta";

export type PluginKind = "provider" | "scheme" | "mimetype";

export interface PluginManifest {
    kind: PluginKind;
    name: string;
    builtAgainst?: string;
    compatibleWith?: string;
}

export interface DiscoveredPlugin {
    packageName: string;
    packagePath: string;
    manifest: PluginManifest;
}

export default class PluginLoader {
    static #isValidKind(kind: unknown): kind is PluginKind {
        return kind === "provider" || kind === "scheme" || kind === "mimetype";
    }

    static async discoverPlugins(nodeModulesDir: string): Promise<DiscoveredPlugin[]> {
        const candidates = await Meta.packageDirs(nodeModulesDir);

        const discovered: DiscoveredPlugin[] = [];
        for (const { dir: packagePath, name } of candidates) {
            if (!Meta.isTrusted(name)) continue;
            let pkg: { name?: string; plurnk?: unknown; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
            try {
                const content = await readFile(resolve(packagePath, "package.json"), "utf8");
                pkg = JSON.parse(content);
            } catch {
                continue;
            }
            if (typeof pkg.name !== "string") continue;
            if (pkg.plurnk === undefined || pkg.plurnk === null || typeof pkg.plurnk !== "object") continue;
            const candidate = pkg.plurnk as { kind?: unknown; name?: unknown };
            if (!PluginLoader.#isValidKind(candidate.kind)) continue;
            if (typeof candidate.name !== "string" || candidate.name.length === 0) continue;
            const builtAgainst = (candidate as { builtAgainst?: unknown }).builtAgainst;
            const headName = {
                provider: "@plurnk/plurnk-providers",
                scheme: "@plurnk/plurnk-schemes",
                mimetype: "@plurnk/plurnk-mimetypes",
            }[candidate.kind];
            const compatibleWith = pkg.peerDependencies?.[headName] ?? pkg.dependencies?.[headName];
            discovered.push({
                packageName: pkg.name,
                packagePath,
                manifest: {
                    kind: candidate.kind,
                    name: candidate.name,
                    ...(typeof builtAgainst === "string" && builtAgainst.length > 0 ? { builtAgainst } : {}),
                    ...(compatibleWith !== undefined ? { compatibleWith } : {}),
                },
            });
        }

        return discovered.toSorted((a, b) => a.packageName.localeCompare(b.packageName));
    }

    // Dynamic-import a discovered plugin's default export and instantiate it.
    // Default export MUST be a constructable class with a zero-arg constructor.
    // Identity-match enforcement per plurnk-mimetypes / plurnk-schemes manifests:
    // the instance's claimed identity MUST match the package manifest's `plurnk.name`.
    // Providers skip this check — manifest.name is a vendor identifier; the
    // instance's `model` is per-config (plurnk-providers#1, identity getters).
    // #514 — the family-head version this daemon IS (lockstep fleet). Resolved once.
    static #headVersion: string | undefined;
    static async headVersion(): Promise<string> {
        if (PluginLoader.#headVersion === undefined) {
            const pkg = JSON.parse(await readFile(fileURLToPath(import.meta.resolve("@plurnk/plurnk-service/package.json")), "utf8")) as { version: string };
            PluginLoader.#headVersion = pkg.version;
        }
        return PluginLoader.#headVersion;
    }
    static #legacyWarned = new Set<string>();
    static #supports(range: string, version: string): boolean {
        const r = /^~(\d+)\.(\d+)\.(\d+)$/.exec(range);
        const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
        return r !== null && v !== null && r[1] === v[1] && r[2] === v[2] && Number(v[3]) >= Number(r[3]);
    }

    static async loadPlugin(plugin: DiscoveredPlugin): Promise<unknown> {
        const head = await PluginLoader.headVersion();
        if (plugin.manifest.compatibleWith !== undefined && !PluginLoader.#supports(plugin.manifest.compatibleWith, head)) {
            throw new Error(`${plugin.packageName} supports ${plugin.manifest.compatibleWith}; loaded ${head}.`);
        }
        if ((plugin.manifest.compatibleWith === undefined || plugin.manifest.builtAgainst === undefined)
            && !PluginLoader.#legacyWarned.has(plugin.packageName)) {
            PluginLoader.#legacyWarned.add(plugin.packageName);
            process.stderr.write(`plurnk-service: ${plugin.packageName} has no compatibility/provenance metadata — loading unverified against ${head}\n`);
        }
        const mod = await import(plugin.packageName);
        const PluginClass = mod.default;
        if (typeof PluginClass !== "function") {
            throw new Error(`${plugin.packageName}: default export is not a constructor`);
        }
        const instance = new PluginClass();
        PluginLoader.assertIdentityMatch(plugin, instance);
        return instance;
    }

    static assertIdentityMatch(plugin: DiscoveredPlugin, instance: unknown): void {
        if (plugin.manifest.kind === "mimetype") {
            const declared = (instance as { mimetype?: unknown }).mimetype;
            if (typeof declared !== "string") {
                throw new Error(
                    `${plugin.packageName}: mimetype handler instance must declare a string \`mimetype\` field`,
                );
            }
            if (declared !== plugin.manifest.name) {
                throw new Error(
                    `${plugin.packageName}: identity mismatch — package manifest declares mimetype '${plugin.manifest.name}', instance declares '${declared}'`,
                );
            }
            return;
        }

        if (plugin.manifest.kind === "scheme") {
            // Schemes carry a static `manifest` on the class (plurnk-schemes contract).
            // Transitional: bundled schemes don't yet have it (task #32 wires
            // manifest registration). When the static manifest is absent, accept
            // the package manifest name as the source of truth and trust the caller.
            const classManifest = (instance as object).constructor as { manifest?: { name?: unknown } };
            const declared = classManifest?.manifest?.name;
            if (declared !== undefined && declared !== plugin.manifest.name) {
                throw new Error(
                    `${plugin.packageName}: identity mismatch — package manifest declares scheme '${plugin.manifest.name}', class manifest declares '${String(declared)}'`,
                );
            }
            return;
        }

        // Providers: no identity-match at this layer. Package manifest `name` is
        // the vendor family; instance `model` is per-config (plurnk-providers#1).
    }
}
