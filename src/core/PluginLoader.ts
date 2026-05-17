// Plugin discovery + loading for the daemon. SPEC §9.
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

const isValidKind = (kind: unknown): kind is PluginKind =>
    kind === "provider" || kind === "scheme" || kind === "mimetype";

export const discoverPlugins = async (nodeModulesDir: string): Promise<DiscoveredPlugin[]> => {
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
        if (!isValidKind(candidate.kind)) continue;
        if (typeof candidate.name !== "string" || candidate.name.length === 0) continue;
        discovered.push({
            packageName: pkg.name,
            packagePath,
            manifest: { kind: candidate.kind, name: candidate.name },
        });
    }

    return discovered.toSorted((a, b) => a.packageName.localeCompare(b.packageName));
};

// Dynamic-import a discovered plugin's default export and instantiate it.
// Default export MUST be a constructable class with a zero-arg constructor.
export const loadPlugin = async (plugin: DiscoveredPlugin): Promise<unknown> => {
    const mod = await import(plugin.packageName);
    const PluginClass = mod.default;
    if (typeof PluginClass !== "function") {
        throw new Error(`${plugin.packageName}: default export is not a constructor`);
    }
    return new PluginClass();
};
