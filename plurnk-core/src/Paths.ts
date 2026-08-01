// Package-relative paths to non-code artifacts.
//
// `migrations` ships in this package's tarball.
// `instructionsSystem` resolves to the canonical model reference in the
// contracts package. Plurnk-service does not carry a second copy.
//
// Lives at src/ (one level above the package root, like the index barrel that
// re-exports it) so `..` resolves to PACKAGE_ROOT.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export default class Paths {
    static #PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    static #CONTRACTS_ROOT = dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-contracts/package.json")));
    // The teaching corpus (scheme docs, personality, requirements) lives in @plurnk/plurnk-meta —
    // the metaproject layer OWNS the family prose (owner ruling, monorepo cut); the daemon
    // consumes it via the same single-source pull shape as CONTRACTS_ROOT.
    static #DOCS_ROOT = dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-meta/package.json")));

    static migrations = resolve(Paths.#PACKAGE_ROOT, "migrations");
    static instructionsSystem = resolve(Paths.#CONTRACTS_ROOT, "plurnk.md");
    // The default operating policy (seeded to ~/.plurnk/AGENTS.md) + the per-scheme teaching docs.
    static personality = resolve(Paths.#DOCS_ROOT, "PLURNK_PERSONALITY.md");
    static schemeDocs = resolve(Paths.#DOCS_ROOT, "docs");
    // (GBNF artifact resolution moved to Engine.#grammarConstraint — the env value
    // SELECTS the variant from @plurnk/plurnk-contracts; no hardcoded default here, #225.)
    // packet.user.system_requirements DEFAULT. Static contract appended at
    // the end of the user packet — names rules the model has to honor that
    // the grammar block doesn't cover (e.g. "loop concludes with SEND[200]").
    static defaultRequirements = Paths.#resolveDefaultRequirements();

    // Resolve the default requirements file: `PLURNK_SERVICE_REQUIREMENTS` env (absolute
    // or relative-to-package-root) overrides the docs package's `requirements.md`.
    static #resolveDefaultRequirements(): string {
        const env = process.env.PLURNK_SERVICE_REQUIREMENTS;
        if (typeof env === "string" && env.length > 0) {
            return resolve(Paths.#PACKAGE_ROOT, env);
        }
        return resolve(Paths.#DOCS_ROOT, "requirements.md");
    }

    // Operator reference docs auto-READ into every model worker at turn 0.
    // `PLURNK_SERVICE_MD_<ALIAS>=<path>` materializes <path>'s markdown as a
    // `plurnk:///<ALIAS>.md` entry the model READs — an idiomatic, userland way
    // to inject standing context (an ordinary entry + READ op, not a bespoke
    // packet section). `~` expands to home; relative paths resolve
    // against the package root. Resolved fresh each call so it tracks the env.
    static docs(): Array<{ entryName: string; path: string }> {
        const out: Array<{ entryName: string; path: string }> = [];
        for (const [key, value] of Object.entries(process.env)) {
            if (!key.startsWith("PLURNK_SERVICE_MD_") || typeof value !== "string" || value.length === 0) continue;
            const alias = key.slice("PLURNK_SERVICE_MD_".length);
            if (alias.length === 0) continue;
            const expanded = value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value === "~" ? homedir() : value;
            out.push({ entryName: `${alias}.md`, path: resolve(Paths.#PACKAGE_ROOT, expanded) });
        }
        return out;
    }
}
