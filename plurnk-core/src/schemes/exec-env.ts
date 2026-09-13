// SPEC {§exec-env-scoped} — the environment one EXEC subprocess receives.
//
// Two mechanisms, in this order, and they are not the same kind of thing:
//
//   1. The ambient policy (a ceiling). `PLURNK_SERVICE_EXEC_ENV_INHERIT` names what the
//      HOST's environment may contribute at all; `_EXCLUDE` narrows that further. Both are
//      ordinary operator knobs under {§operator-config-env-defaults}, so an operator widens
//      or narrows them, and nothing downstream of this point can widen them again.
//   2. The invariant (not a knob). plurnk's own secrets — `PLURNK_*` config and every
//      provider credential name — are stripped last and unconditionally, so no policy,
//      worker document or heading modifier can ever readmit them.
//
// The ceiling exists because the invariant alone protects the WRONG secrets: it knows
// plurnk's credentials and nothing about the operator's. A denylist passes `SSH_AUTH_SOCK`
// and `NPM_TOKEN` to every command a model writes. Membership is an allowlist.
import { providerCredentialEnvNames } from "@plurnk/plurnk-models";

export default class ExecEnv {
    // A name, or one trailing-`*` prefix glob (`LC_*`). Exact names are the common case;
    // the glob exists for the locale family, which is open-ended by design.
    static #matches(name: string, patterns: readonly string[]): boolean {
        for (const pattern of patterns) {
            if (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern) return true;
        }
        return false;
    }

    static #list(raw: string | undefined): readonly string[] {
        if (raw === undefined) return [];
        return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    }

    // Read at call time (not memoized) so a secret set into process.env after boot is
    // still scoped out of the next spawn, and so an operator's policy edit takes effect
    // on the next spawn rather than the next restart.
    static scoped(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
        const inherit = ExecEnv.#list(env.PLURNK_SERVICE_EXEC_ENV_INHERIT);
        const exclude = ExecEnv.#list(env.PLURNK_SERVICE_EXEC_ENV_EXCLUDE);
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
            // The ceiling. An empty INHERIT admits nothing from the host: the allowlist is
            // declared in `.env.defaults`, so an empty one is an operator who cleared it,
            // not an unconfigured install.
            if (!ExecEnv.#matches(key, inherit)) continue;
            if (ExecEnv.#matches(key, exclude)) continue;
            // The invariant, last and unconditional — plurnk's own, never to a subprocess.
            if (key.startsWith("PLURNK_") || providerKeys.has(key)) continue;
            out[key] = value;
        }
        return out;
    }
}
