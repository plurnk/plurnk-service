// Plugin discovery + loading for the daemon. SPEC §plugin-discovery.
//
// Boot-time scan of node_modules/@plurnk/*/package.json — filter for those
// with a `plurnk` manifest field, dynamic-import them, register with the
// matching registry by kind. Alphabetical load order; collisions on
// (kind, name) fail-hard at registration time.

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type PluginKind = "provider" | "scheme" | "mimetype";

export interface PluginManifest {
    kind: PluginKind;
    name: string;
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
        const plurnkDir = resolve(nodeModulesDir, "@plurnk");
        let entries: Array<{ name: string; isDirectory: () => boolean }>;
        try {
            entries = await readdir(plurnkDir, { withFileTypes: true });
        } catch {
            return [];
        }

        const discovered: DiscoveredPlugin[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const packagePath = resolve(plurnkDir, entry.name);
            const packageJsonPath = resolve(packagePath, "package.json");
            let pkg: { name?: string; plurnk?: unknown };
            try {
                const content = await readFile(packageJsonPath, "utf8");
                pkg = JSON.parse(content);
            } catch {
                continue;
            }
            if (typeof pkg.name !== "string") continue;
            if (pkg.plurnk === undefined || pkg.plurnk === null || typeof pkg.plurnk !== "object") continue;
            const candidate = pkg.plurnk as { kind?: unknown; name?: unknown };
            if (!PluginLoader.#isValidKind(candidate.kind)) continue;
            if (typeof candidate.name !== "string" || candidate.name.length === 0) continue;
            discovered.push({
                packageName: pkg.name,
                packagePath,
                manifest: { kind: candidate.kind, name: candidate.name },
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
    static async loadPlugin(plugin: DiscoveredPlugin): Promise<unknown> {
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
