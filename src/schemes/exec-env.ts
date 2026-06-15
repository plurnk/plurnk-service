// SPEC §exec {§exec-env-scoped} — the environment an EXEC subprocess receives.
//
// It gets the *project's* environment (its `.env`, the standard shell vars like PATH
// and HOME) so the model's commands run as the project expects — but never plurnk's
// own secrets: the `PLURNK_*` config (all of plurnk's knobs are prefixed; see
// .env.example) and the provider API keys plurnk-providers reads. The provider key-vars
// are sourced from STANDARD_PROVIDERS so the denylist tracks the provider set rather
// than a hand-maintained list that drifts as providers are added.
//
// A denylist, not an allowlist: a subprocess needs the long tail of inherited vars
// (PATH, HOME, LANG, the project's own keys); only plurnk's two owned families are
// stripped. The service owns this policy; the executor (plurnk-execs SubprocessExecutor,
// plurnk-execs#8) spawns with the env it is handed.

import { STANDARD_PROVIDERS } from "@plurnk/plurnk-providers";

export default class ExecEnv {
    static #providerKeys: ReadonlySet<string> = new Set(
        Object.values(STANDARD_PROVIDERS).map((spec) => spec.apiKeyVar),
    );

    // Read at call time (not memoized) so a secret set into process.env after boot is
    // still scoped out of the next spawn.
    static scoped(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
        const out: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(env)) {
            if (key.startsWith("PLURNK_") || ExecEnv.#providerKeys.has(key)) continue;  // plurnk's own — never to a subprocess
            out[key] = value;
        }
        return out;
    }
}
