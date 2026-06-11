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

export default class Paths {
    static #PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    static #GRAMMAR_ROOT = dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-grammar/package.json")));

    static migrations = resolve(Paths.#PACKAGE_ROOT, "migrations");
    static instructionsSystem = resolve(Paths.#GRAMMAR_ROOT, "plurnk.md");
    // The GBNF artifact (the full multi-op root) for grammar-constrained
    // sampling, resolved from the grammar package like the sysprompt above.
    // Plumbed to the provider per generate() when PLURNK_PROVIDERS_GBNF is
    // enabled; the service holds no opinion about its content or root.
    static grammarGbnf = resolve(Paths.#GRAMMAR_ROOT, "dist/plurnk.gbnf");
    // packet.system.persona DEFAULT. Cascade at packet-build time is
    //   loops.persona > runs.persona > sessions.persona > this file
    // RPC overrides on loop.run / session.attach / session.create populate
    // the three persistence layers; this file is the final fallback.
    static defaultPersona = Paths.#resolveDefaultPersona();
    // packet.user.system_requirements DEFAULT. Static contract appended at
    // the end of the user packet — names rules the model has to honor that
    // the grammar block doesn't cover (e.g. "loop concludes with SEND[200]").
    static defaultRequirements = Paths.#resolveDefaultRequirements();

    // Resolve the default persona file path: PLURNK_PERSONA env (absolute or
    // relative-to-package-root) → `persona.md` in package root as the
    // hardcoded fallback. The env var lets operators point at a custom
    // persona without forking the file in PACKAGE_ROOT.
    static #resolveDefaultPersona(): string {
        const env = process.env.PLURNK_PERSONA;
        if (typeof env === "string" && env.length > 0) {
            return resolve(Paths.#PACKAGE_ROOT, env);
        }
        return resolve(Paths.#PACKAGE_ROOT, "persona.md");
    }

    // Same shape as #resolveDefaultPersona: `PLURNK_REQUIREMENTS` env (absolute
    // or relative-to-package-root) overrides the in-package `requirements.md`.
    static #resolveDefaultRequirements(): string {
        const env = process.env.PLURNK_REQUIREMENTS;
        if (typeof env === "string" && env.length > 0) {
            return resolve(Paths.#PACKAGE_ROOT, env);
        }
        return resolve(Paths.#PACKAGE_ROOT, "requirements.md");
    }
}
