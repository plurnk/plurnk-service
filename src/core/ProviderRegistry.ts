// Model alias resolution. Reads PLURNK_MODEL_<alias>=<provider>/<model> env
// vars; PLURNK_MODEL=<alias> selects which to use at boot. Each alias maps
// to a provider plugin (`@plurnk/plurnk-providers-<provider>`); the registry
// imports the matching package and constructs it with provider-specific
// env conventions.
//
// Rummy parallel: RUMMY_MODEL_<alias>="<provider>/<model>" cascade. The
// first path segment selects the provider plugin; the rest is the
// provider's own identifier (may contain "/" for tri-level providers like
// openrouter's publisher/model).

import type { PlurnkStatement } from "@plurnk/plurnk-grammar";

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
interface ProviderResponse {
    assistant: { tokens: number; content: string; ops: PlurnkStatement[]; reasoning: string | null };
    assistantRaw: unknown;
}
export interface Provider {
    generate(args: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse>;
    readonly contextSize: number;
    readonly model: string;
}

export interface ProviderAlias {
    readonly alias: string;     // lowercase, the .env key suffix downcased
    readonly provider: string;  // e.g. "openai", "openrouter", "ollama"
    readonly model: string;     // provider-native id; may contain "/" for tri-level providers
}

export const parseAliasesFromEnv = (env: NodeJS.ProcessEnv = process.env): ProviderAlias[] => {
    const out: ProviderAlias[] = [];
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || value.length === 0) continue;
        if (!key.startsWith("PLURNK_MODEL_")) continue;
        const aliasRaw = key.slice("PLURNK_MODEL_".length);
        if (aliasRaw.length === 0) continue;
        const slash = value.indexOf("/");
        if (slash <= 0) continue;
        out.push({
            alias: aliasRaw.toLowerCase(),
            provider: value.slice(0, slash),
            model: value.slice(slash + 1),
        });
    }
    return out;
};

export const resolveActiveAlias = (env: NodeJS.ProcessEnv = process.env): ProviderAlias | null => {
    const selected = env.PLURNK_MODEL;
    if (selected === undefined || selected.length === 0) return null;
    const aliases = parseAliasesFromEnv(env);
    return aliases.find((a) => a.alias === selected.toLowerCase()) ?? null;
};

// Generic per-provider instantiation. Each provider package exports a
// `static fromEnv(env, model)` factory that knows its own env-config
// conventions (OPENAI_BASE_URL, ANTHROPIC_API_KEY, etc.). plurnk-service
// stays out of per-provider config knowledge.
//
// PROVIDERS.md §3.7 documents the factory contract. PLURNK_REASON
// (numeric reasoning-token budget) is universal — each provider's
// fromEnv reads it and translates to its own wire format.
interface ProviderFactory {
    fromEnv(env: NodeJS.ProcessEnv, model: string): Provider | Promise<Provider>;
}

export const instantiateProvider = async (alias: ProviderAlias, env: NodeJS.ProcessEnv = process.env): Promise<Provider> => {
    const packageName = `@plurnk/plurnk-providers-${alias.provider}`;
    let mod: { default: ProviderFactory };
    try {
        mod = await import(packageName);
    } catch (cause) {
        throw new Error(
            `provider package ${packageName} not installed (alias '${alias.alias}' requires it): ` +
            (cause instanceof Error ? cause.message : String(cause)),
        );
    }
    const factory = mod.default;
    if (typeof factory?.fromEnv !== "function") {
        throw new Error(
            `${packageName}: default export must have a static \`fromEnv(env, model)\` factory ` +
            `(PROVIDERS.md §3.7)`,
        );
    }
    return await factory.fromEnv(env, alias.model);
};

// Convenience: resolve + instantiate in one call. Returns null when no
// PLURNK_MODEL is set (caller decides what 'no provider' means).
export const loadActiveProvider = async (env: NodeJS.ProcessEnv = process.env): Promise<Provider | null> => {
    const alias = resolveActiveAlias(env);
    if (alias === null) return null;
    return instantiateProvider(alias, env);
};
