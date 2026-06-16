// Package-relative paths to non-code artifacts.
//
// `migrations` ships in this package's tarball.
// `instructionsSystem` resolves to `plurnk.md` IN THE GRAMMAR PACKAGE — single
// source of truth lives upstream. Plurnk-service doesn't carry its own copy;
// the grammar agent owns the prose.
//
// Lives at src/ (one level above the package root, like the index barrel that
// re-exports it) so `..` resolves to PACKAGE_ROOT.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export default class Paths {
    static #PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    static #GRAMMAR_ROOT = dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-grammar/package.json")));

    static migrations = resolve(Paths.#PACKAGE_ROOT, "migrations");
    static instructionsSystem = resolve(Paths.#GRAMMAR_ROOT, "plurnk.md");
    // (GBNF artifact resolution moved to Engine.#grammarConstraint — the env value
    // SELECTS the variant from @plurnk/plurnk-grammar; no hardcoded default here, #225.)
    // packet.user.system_requirements DEFAULT. Static contract appended at
    // the end of the user packet — names rules the model has to honor that
    // the grammar block doesn't cover (e.g. "loop concludes with SEND[200]").
    static defaultRequirements = Paths.#resolveDefaultRequirements();

    // Resolve the default requirements file: `PLURNK_REQUIREMENTS` env (absolute
    // or relative-to-package-root) overrides the in-package `requirements.md`.
    static #resolveDefaultRequirements(): string {
        const env = process.env.PLURNK_REQUIREMENTS;
        if (typeof env === "string" && env.length > 0) {
            return resolve(Paths.#PACKAGE_ROOT, env);
        }
        return resolve(Paths.#PACKAGE_ROOT, "requirements.md");
    }

    // Operator reference docs auto-READ into every model run at turn 0.
    // `PLURNK_MD_<ALIAS>=<path>` materializes <path>'s markdown as a
    // `plurnk:///<ALIAS>.md` entry the model READs — an idiomatic, userland way
    // to inject standing context (an ordinary entry + READ op, not a bespoke
    // packet section). `~` expands to home; relative paths resolve
    // against the package root. Resolved fresh each call so it tracks the env.
    static docs(): Array<{ entryName: string; path: string }> {
        const out: Array<{ entryName: string; path: string }> = [];
        for (const [key, value] of Object.entries(process.env)) {
            if (!key.startsWith("PLURNK_MD_") || typeof value !== "string" || value.length === 0) continue;
            const alias = key.slice("PLURNK_MD_".length);
            if (alias.length === 0) continue;
            const expanded = value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value === "~" ? homedir() : value;
            out.push({ entryName: `${alias}.md`, path: resolve(Paths.#PACKAGE_ROOT, expanded) });
        }
        return out;
    }
}
