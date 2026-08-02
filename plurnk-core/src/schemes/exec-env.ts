// SPEC {§exec} {§exec-env-scoped} — the environment an EXEC subprocess receives.
//
// It gets the *project's* environment (its `.env`, the standard shell vars like PATH
// and HOME) so the model's commands run as the project expects — but never plurnk's
// own secrets: the `PLURNK_*` config (all of plurnk's knobs are prefixed; see
// .env.defaults) and the provider API keys plurnk-providers reads. The provider key-vars
// are sourced from the vendored models.dev provider catalog so the denylist tracks the provider set rather
// than a hand-maintained list that drifts as providers are added.
//
// A denylist, not an allowlist: a subprocess needs the long tail of inherited vars
// (PATH, HOME, LANG, the project's own keys); only plurnk's two owned families are
// stripped. The service owns this policy; the executor (plurnk-execs SubprocessExecutor,
// plurnk-execs#8) spawns with the env it is handed.

import { providerCredentialEnvNames } from "@plurnk/plurnk-models";

export default class ExecEnv {
    // Read at call time (not memoized) so a secret set into process.env after boot is
    // still scoped out of the next spawn.
    static scoped(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
        const providerKeys = new Set(
            providerCredentialEnvNames(),
        );
        for (const [key, value] of Object.entries(env)) {
            if (!key.startsWith("PLURNK_PROVIDERS_PROVIDER_") || !key.endsWith("_API_KEY_ENV")) continue;
            for (const name of value?.split(",") ?? []) {
                const trimmed = name.trim();
                if (trimmed.length > 0) providerKeys.add(trimmed);
            }
        }
        const out: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(env)) {
            if (key.startsWith("PLURNK_") || providerKeys.has(key)) continue;  // plurnk's own — never to a subprocess
            out[key] = value;
        }
        return out;
    }
}
