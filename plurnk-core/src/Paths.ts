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
import {
    TEACHING_CORPUS,
    type TeachingCorpusSource,
} from "@plurnk/plurnk-meta";

export default class Paths {
    static #PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    static #CONTRACTS_ROOT = dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-contracts/package.json")));
    // {§teaching-corpus} — core consumes the teaching sources owned by
    // @plurnk/plurnk-meta; admission and projection remain core-owned.
    static readonly teachingRoot = dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-meta/package.json")));

    static readonly packageRoot = Paths.#PACKAGE_ROOT;
    static migrations = resolve(Paths.#PACKAGE_ROOT, "migrations");
    static instructionsSystem = resolve(Paths.#CONTRACTS_ROOT, "plurnk.md");
    static sharedDefaults = resolve(Paths.#CONTRACTS_ROOT, ".env.defaults");
    static configuration = resolve(Paths.#PACKAGE_ROOT, "INSTALL.md");
    static systemdUnit = resolve(Paths.#PACKAGE_ROOT, "plurnk.service");
    static nginxConfig = resolve(Paths.#PACKAGE_ROOT, "plurnk.nginx.conf");
    // The first-run policy seed and built-in/conditional pull-doc sources.
    static policy = Paths.teachingSource(TEACHING_CORPUS.policy);

    static teachingSource(source: TeachingCorpusSource): string {
        return resolve(Paths.teachingRoot, source);
    }
}
