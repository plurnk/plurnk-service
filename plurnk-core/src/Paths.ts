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
import { TEACHING_CORPUS, type TeachingCorpusSource } from "@plurnk/plurnk-meta";

export default class Paths {
    static #PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    static #CONTRACTS_ROOT = dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-contracts/package.json")));
    // {§teaching-corpus} — core consumes the teaching sources owned by
    // @plurnk/plurnk-meta; admission and projection remain core-owned.
    static readonly teachingRoot = dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-meta/package.json")));

    static migrations = resolve(Paths.#PACKAGE_ROOT, "migrations");
    static instructionsSystem = resolve(Paths.#CONTRACTS_ROOT, "plurnk.md");
    // The first-run policy seed and built-in/conditional pull-doc sources.
    static personality = Paths.teachingSource(TEACHING_CORPUS.personality);
    // {§requirements} — meta-owned default Recap and its operator override.
    static #DEFAULT_REQUIREMENTS = Paths.#resolveDefaultRequirements();
    static defaultRequirements = Paths.#DEFAULT_REQUIREMENTS.path;
    static defaultRequirementsTeachingSource = Paths.#DEFAULT_REQUIREMENTS.source;

    static teachingSource(source: TeachingCorpusSource): string {
        return resolve(Paths.teachingRoot, source);
    }

    // Absolute overrides stay absolute; relative paths resolve from the package root.
    static #resolveDefaultRequirements(): { path: string; source: TeachingCorpusSource | null } {
        const env = process.env.PLURNK_SERVICE_REQUIREMENTS;
        if (typeof env === "string" && env.length > 0) {
            return { path: resolve(Paths.#PACKAGE_ROOT, env), source: null };
        }
        return {
            path: Paths.teachingSource(TEACHING_CORPUS.requirements),
            source: TEACHING_CORPUS.requirements,
        };
    }

    // Operator reference material rides the skills tree ({§skills-materialization}).
}
