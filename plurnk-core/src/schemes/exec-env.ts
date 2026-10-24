// {§exec-env-scoped} Ambient admission and ordinary env-name reservation.
// Explicit capability bindings belong to their module ({§mcp-launch-environment}).
import { providerCredentialEnvNames } from "@plurnk/plurnk-models";
import type HostPaths from "../core/HostPaths.ts";

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

    // {§mcp-launch-environment} Module-owned launches start with this ambient base,
    // not the model-command ceiling; their explicit bindings are a separate input.
    static withoutOwnSecrets(env: NodeJS.ProcessEnv = process.env, hostPaths?: HostPaths): NodeJS.ProcessEnv {
        const source = hostPaths === undefined ? env : hostPaths.projectEnvironment(env);
        const providerKeys = ExecEnv.#ownSecretNames(source);
        const out: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(source)) {
            if (key.startsWith("PLURNK_") || providerKeys.has(key)) continue;
            out[key] = value;
        }
        return out;
    }

    // {§env-functionality} {§env-option} Ordinary entries and modifiers reserve these
    // names even when supplying literal values rather than inheriting host values.
    static ownSecretTest(env: NodeJS.ProcessEnv = process.env): (name: string) => boolean {
        const names = ExecEnv.#ownSecretNames(env);
        return (name: string) => name.startsWith("PLURNK_") || names.has(name);
    }

    static #ownSecretNames(env: NodeJS.ProcessEnv): Set<string> {
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
        return providerKeys;
    }

    // Read at call time (not memoized) so a secret set into process.env after boot is
    // still scoped out of the next spawn, and so an operator's policy edit takes effect
    // on the next spawn rather than the next restart.
    static scoped(env: NodeJS.ProcessEnv = process.env, hostPaths?: HostPaths): NodeJS.ProcessEnv {
        const source = hostPaths === undefined ? env : hostPaths.projectEnvironment(env);
        const inherit = ExecEnv.#list(source.PLURNK_SERVICE_EXEC_ENV_INHERIT);
        const exclude = ExecEnv.#list(source.PLURNK_SERVICE_EXEC_ENV_EXCLUDE);
        const providerKeys = ExecEnv.#ownSecretNames(source);
        const out: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(source)) {
            // The ceiling. An empty INHERIT admits nothing from the host: the allowlist is
            // declared in `.env.defaults`, so an empty one is an operator who cleared it,
            // not an unconfigured install.
            if (!ExecEnv.#matches(key, inherit)) continue;
            if (ExecEnv.#matches(key, exclude)) continue;
            // Reserved names remain excluded even when the ambient selectors name them.
            if (key.startsWith("PLURNK_") || providerKeys.has(key)) continue;
            out[key] = value;
        }
        return out;
    }
}
