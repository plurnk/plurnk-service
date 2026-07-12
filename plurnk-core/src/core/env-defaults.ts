import { parseEnv } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// The .env.defaults standard (§operator-config-env-defaults, owner design): every package in the
// daemon's ecosystem — internal or third-party — ships a `.env.defaults` at its package root
// declaring ITS OWN knobs (prefix = its name), with the file itself as the documentation. The
// daemon assembles every installed member's file into ONE floor, applied set-if-unset under the
// operator's env (shell > ~/.plurnk/.env > ./.env > this floor), and renders the assembled
// catalog to ~/.plurnk/.env.defaults each boot — a machine-owned legend, never read back.
//
// ONE physical law, everything else convention: a key claimed by two packages CRASHES boot
// naming both. With the reader-declares discipline (every knob a package reads appears in its
// own file) squatting is structurally impossible, and knob-reading code needs no inline
// fallback — the floor guarantees the value exists.
//
// Membership = the `@plurnk/*` scope OR a `plurnk` field in package.json (the same marker the
// exec/scheme discovery keys on), gated by PLURNK_PLUGINS_TRUSTED_ONLY exactly like
// plurnk-execs discover(): unset/""/"0" trusts everything; any value trusts @plurnk/* plus a
// comma-separated allowlist.
export type EnvDefaultsFile = {
    owner: string;                    // package name (or "@plurnk/plurnk-service" for the host)
    text: string;                     // the raw file — comments included; the catalog preserves them
    parsed: Record<string, string>;
};

export default class EnvDefaults {
    // THE ecosystem trust rule (SPEC §operator-config-env-defaults) — shared by the env
    // floor and plugin discovery; a second definition of membership trust is a bug.
    static isTrusted(packageName: string): boolean {
        const gate = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        if (gate === undefined || gate === "" || gate === "0") return true;
        if (packageName.startsWith("@plurnk/")) return true;
        return gate.split(",").map((s) => s.trim()).includes(packageName);
    }

    static async #readDefaults(dir: string, owner: string): Promise<EnvDefaultsFile | null> {
        let text: string;
        try { text = await readFile(join(dir, ".env.defaults"), "utf8"); }
        catch { return null; }
        // parseEnv never throws — it silently mints junk keys from malformed lines. Malformed =
        // any parsed key that isn't a valid env name; crash naming the owner — a broken defaults
        // file is a broken package, never a silently-degraded floor.
        const parsed = parseEnv(text) as Record<string, string>;
        const junk = Object.keys(parsed).filter((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
        if (junk.length > 0) throw new Error(`${owner}: malformed .env.defaults — invalid key(s): ${junk.map((k) => JSON.stringify(k)).join(", ")}`);
        return { owner, text, parsed };
    }

    // Enumerate installed package dirs — scoped + unscoped — under nodeModules (the same walk
    // shape as plurnk-execs discover()); keep ecosystem members that ship a .env.defaults.
    static async #memberFiles(nodeModules: string): Promise<EnvDefaultsFile[]> {
        let entries;
        try { entries = await readdir(nodeModules, { withFileTypes: true }); }
        catch { return []; }
        const dirs: Array<{ dir: string; name: string }> = [];
        for (const entry of entries) {
            // symlinks included: workspace checkouts link every sibling package into
            // node_modules; a dirent-only isDirectory() reads them as non-dirs
            if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name === ".bin" || entry.name === ".cache") continue;
            if (entry.name.startsWith("@")) {
                const scopeDir = join(nodeModules, entry.name);
                try {
                    for (const s of await readdir(scopeDir, { withFileTypes: true })) {
                        if (s.isDirectory() || s.isSymbolicLink()) dirs.push({ dir: join(scopeDir, s.name), name: `${entry.name}/${s.name}` });
                    }
                } catch { /* unreadable scope dir — skip */ }
            } else {
                dirs.push({ dir: join(nodeModules, entry.name), name: entry.name });
            }
        }
        const files: EnvDefaultsFile[] = [];
        for (const { dir, name } of dirs.toSorted((a, b) => a.name.localeCompare(b.name))) {
            if (!EnvDefaults.isTrusted(name)) continue;
            if (!name.startsWith("@plurnk/")) {
                let pkg: { plurnk?: unknown };
                try { pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { plurnk?: unknown }; }
                catch { continue; }
                if (pkg.plurnk === undefined) continue; // not an ecosystem member
            }
            const file = await EnvDefaults.#readDefaults(dir, name);
            if (file !== null) files.push(file);
        }
        return files;
    }

    // The host's own file first, then every installed member's, name-sorted (deterministic).
    // The host is excluded from the member scan — a workspace checkout symlinks the daemon
    // into node_modules as its own member, and self-vs-self is not a collision.
    static async collect(serviceRoot: string, nodeModules: string): Promise<EnvDefaultsFile[]> {
        const own = await EnvDefaults.#readDefaults(serviceRoot, "@plurnk/plurnk-service");
        if (own === null) throw new Error("@plurnk/plurnk-service: .env.defaults missing from the package root — the shipped floor is not optional");
        const members = await EnvDefaults.#memberFiles(nodeModules);
        return [own, ...members.filter((m) => m.owner !== own.owner)];
    }

    // The ONE law: global key uniqueness. A collision names both claimants — it is also the
    // deliberate handoff signal when a sibling adopts a section the host carried for it.
    static merge(files: readonly EnvDefaultsFile[]): Map<string, { value: string; owner: string }> {
        const merged = new Map<string, { value: string; owner: string }>();
        for (const { owner, parsed } of files) {
            for (const [key, value] of Object.entries(parsed)) {
                const prior = merged.get(key);
                if (prior !== undefined) throw new Error(`env-defaults collision: ${key} is claimed by both ${prior.owner} and ${owner} — a knob has exactly one owner`);
                merged.set(key, { value, owner });
            }
        }
        return merged;
    }

    // The floor: set-if-unset, under everything the operator already set.
    static apply(merged: ReadonlyMap<string, { value: string; owner: string }>): void {
        for (const [key, { value }] of merged) process.env[key] ??= value;
    }

    // ~/.plurnk/.env.defaults — the operator's catalog: every member's raw file (comments are the
    // docs), owner-labelled. Machine-owned, regenerated each boot, never read back as config.
    static renderCatalog(files: readonly EnvDefaultsFile[]): string {
        const head = [
            "# ⚠ MACHINE-OWNED — regenerated on every daemon boot from the installed packages'",
            "# .env.defaults files. Do NOT edit; your config lives in ~/.plurnk/.env (yours, wins",
            "# over this floor) or the shell env. One section per owning package.",
            "",
        ].join("\n");
        return head + files.map(({ owner, text }) => `# ═══ ${owner} ═══\n${text.trimEnd()}\n`).join("\n");
    }
}
