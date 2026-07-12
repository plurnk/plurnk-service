// Plugin-membership primitives for the plurnk ecosystem — the metaproject-level
// mechanics every discovery surface shares (AGENTS §topology, core SPEC
// §plugin-discovery / §operator-config-env-defaults):
//   - isTrusted:          THE trust rule. One implementation; a second definition
//                         of membership trust anywhere in the family is a bug.
//   - packageDirs:        scope-agnostic, symlink-aware enumeration of installed
//                         packages. Returns candidates; ORDERING AND FILTERING ARE
//                         THE CALLER'S POLICY (mimetypes loads @plurnk last for
//                         collision precedence; others sort by name).
//   - nearestNodeModules: deployment-root resolution — walk up to the nearest
//                         node_modules holding the ecosystem (witness: @plurnk).
//                         Registry installs hit the install root; workspace
//                         checkouts escape node_modules via symlink realpaths and
//                         land on the monorepo root's. Null when nothing is found;
//                         the fallback is the caller's policy.

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface PackageCandidate {
    dir: string;
    name: string;
}

export default class Plugins {
    // unset / "" / "0" → gate OFF: everything installed is trusted.
    // any other value  → gate ON: @plurnk/* always trusted, plus a comma-separated
    //                    allowlist; "1" (naming no real package) = on, zero third-party.
    static isTrusted(packageName: string, env: Record<string, string | undefined> = process.env): boolean {
        const value = env.PLURNK_PLUGINS_TRUSTED_ONLY?.trim() ?? "";
        if (value === "" || value === "0") return true;
        if (packageName.startsWith("@plurnk/")) return true;
        return value.split(",").map((s) => s.trim()).includes(packageName);
    }

    // Every installed package dir under nodeModulesDir — unscoped (`name`) and scoped
    // (`@scope/name`) alike. Symlinks included: workspace checkouts link every sibling
    // into node_modules, and a dirent-only isDirectory() reads them as non-dirs.
    // Non-package entries (.bin, .cache, dotfiles) are skipped. No node_modules → [].
    static async packageDirs(nodeModulesDir: string): Promise<PackageCandidate[]> {
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
