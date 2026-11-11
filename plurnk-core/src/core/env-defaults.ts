import { errnoCode } from "@plurnk/plurnk-contracts";
import { parseEnv } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Meta, { type PackageCandidate } from "@plurnk/plurnk-meta";

// Each first-party `@plurnk/*` package owns its configuration keys and panel ({§operator-config-precedence}).
// The daemon assembles those files into the lowest-precedence floor and renders the same sources
// on demand through `config defaults`, never a second file. Duplicate ownership fails boot naming
// both packages.
export type EnvDefaultsFile = {
    owner: string;                    // package name (or "@plurnk/plurnk-service" for the host)
    text: string;                     // the raw file — comments included; the catalog preserves them
    parsed: Record<string, string>;
};

export default class EnvDefaults {

    static async #readDefaults(dir: string, owner: string): Promise<EnvDefaultsFile | null> {
        let text: string;
        try { text = await readFile(join(dir, ".env.defaults"), "utf8"); }
        catch (cause) {
            if (errnoCode(cause) === "ENOENT") return null;
            throw new Error(`${owner}: cannot read .env.defaults.`, { cause });
        }
        // parseEnv never throws — it silently mints junk keys from malformed lines. Malformed =
        // any parsed key that isn't a valid env name; crash naming the owner — a broken defaults
        // file is a broken package, never a silently-degraded floor.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parseEnv's Dict typing admits undefined values its parser never yields
        const parsed = parseEnv(text) as Record<string, string>;
        const junk = Object.keys(parsed).filter((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
        if (junk.length > 0) throw new Error(`${owner}: malformed .env.defaults — invalid key(s): ${junk.map((k) => JSON.stringify(k)).join(", ")}`);
        return { owner, text, parsed };
    }

    // The installed first-party ecosystem members, name-sorted: packages in the `@plurnk/*` scope.
    // The defaults floor and the plurnk skill's contracts index share this one membership
    // ({§tools-resource-materialization}).
    static members(dirs: readonly PackageCandidate[]): PackageCandidate[] {
        return dirs
            .filter((candidate) => candidate.name.startsWith("@plurnk/"))
            .toSorted((a, b) => a.name.localeCompare(b.name));
    }

    static async #memberFiles(dirs: readonly PackageCandidate[]): Promise<EnvDefaultsFile[]> {
        const files: EnvDefaultsFile[] = [];
        for (const { dir, name } of EnvDefaults.members(dirs)) {
            const file = await EnvDefaults.#readDefaults(dir, name);
            if (file !== null) files.push(file);
        }
        return files;
    }

    // The host's own file first, then every installed `@plurnk/*` member's, name-sorted (deterministic).
    // The host is excluded from the member scan — a workspace checkout symlinks the daemon
    // into node_modules as its own member, and self-vs-self is not a collision.
    static async collect(serviceRoot: string, nodeModules: string): Promise<EnvDefaultsFile[]> {
        const own = await EnvDefaults.#readDefaults(serviceRoot, "@plurnk/plurnk-service");
        if (own === null) throw new Error("@plurnk/plurnk-service: .env.defaults missing from the package root — the shipped floor is not optional");
        const members = await EnvDefaults.#memberFiles(await Meta.packageDirs(nodeModules));
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

    // The operator's on-demand catalog: every member's raw file (comments are
    // the docs), owner-labelled, with no effective values or persisted copy.
    static renderCatalog(files: readonly EnvDefaultsFile[]): string {
        const head = [
            "# Plurnk installed configuration defaults",
            "# Generated on demand from each installed package's .env.defaults.",
            "# This output is documentation, not an input file. Put user overrides in",
            "# $XDG_CONFIG_HOME/plurnk/.env, a file selected with --config or --env-file,",
            "# or the shell environment. A working directory's .env is not read.",
            "# Effective secret values are never projected here.",
            "",
        ].join("\n");
        return head + files.map(({ owner, text }) => `# ═══ ${owner} ═══\n${text.trimEnd()}\n`).join("\n");
    }
}
