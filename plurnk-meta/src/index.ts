// The metaproject layer's membership slice — the mechanics every discovery
// surface shares ({§plugin-discovery} / {§operator-config-env-defaults}):
//   - declaresKind:      the ONE package → capability-family representation.
//   - isTrusted:          THE trust rule. One implementation; a second definition
//                         of membership trust anywhere in the family is a bug.
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

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface PackageCandidate {
    dir: string;
    name: string;
}

export type PluginKind = "exec" | "mimetype" | "provider" | "scheme";

export default class Meta {
    static declaresKind(manifest: unknown, kind: PluginKind): boolean {
        if (typeof manifest !== "object" || manifest === null) return false;
        return (manifest as { kind?: unknown }).kind === kind;
    }

    // unset / "" / "0" → gate OFF: everything installed is trusted.
    // any other value  → gate ON: @plurnk/* always trusted, plus a comma-separated
    //                    allowlist; "1" (naming no real package) = on, zero third-party.
    static isTrusted(packageName: string, env: Record<string, string | undefined> = process.env): boolean {
        const value = env.PLURNK_PLUGINS_TRUSTED_ONLY?.trim() ?? "";
        if (value === "" || value === "0") return true;
        if (packageName.startsWith("@plurnk/")) return true;
        return value.split(",").map((s) => s.trim()).includes(packageName);
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
