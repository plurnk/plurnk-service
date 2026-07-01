// The plurnk model-alias cascade — pure env parsing, zero runtime deps.
//
// PLURNK_MODEL_<alias>=<provider>/<model> declares an alias; PLURNK_MODEL=<alias>
// selects the active one at boot. The provider segment is the first "/"-delimited
// field; the model id is the remainder (it may itself contain "/"). Aliases are
// case-folded (the .env key suffix downcased). PLURNK_BASEURL_<alias> attaches a
// per-alias endpoint override — the one thing a per-provider base-URL var can't
// express (two aliases on the same provider name pointing at different boxes).
//
// Extracted from @plurnk/plurnk-providers so a thin consumer can resolve aliases
// from its own (always-fresh) env without pulling the provider/tokenizer machinery.

import type { ProviderAlias } from "./types.ts";

// PLURNK_BASEURL_<alias>: per-alias endpoint override, case-folded on the alias
// to match PLURNK_MODEL_<alias>. Lets two aliases on the same provider name target
// different self-hosted boxes (openai/ollama), the one thing a per-name base-URL
// var can't express.
const parseBaseUrls = (env: NodeJS.ProcessEnv): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || value.length === 0) continue;
        if (!key.startsWith("PLURNK_BASEURL_")) continue;
        const aliasRaw = key.slice("PLURNK_BASEURL_".length);
        if (aliasRaw.length === 0) continue;
        out.set(aliasRaw.toLowerCase(), value);
    }
    return out;
};

export const parseAliasesFromEnv = (env: NodeJS.ProcessEnv = process.env): ProviderAlias[] => {
    const out: ProviderAlias[] = [];
    const seen = new Set<string>();
    const baseUrls = parseBaseUrls(env);
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || value.length === 0) continue;
        if (!key.startsWith("PLURNK_MODEL_")) continue;
        const aliasRaw = key.slice("PLURNK_MODEL_".length);
        if (aliasRaw.length === 0) continue;
        const slash = value.indexOf("/");
        if (slash <= 0) continue;
        const alias = aliasRaw.toLowerCase();
        // Aliases are case-folded, so PLURNK_MODEL_opus and PLURNK_MODEL_OPUS
        // collide. Surface the ambiguity rather than silently picking one.
        if (seen.has(alias)) throw new Error(`Duplicate provider alias "${alias}": multiple PLURNK_MODEL_* keys case-fold to the same alias. Rename one.`);
        seen.add(alias);
        const baseUrl = baseUrls.get(alias);
        out.push({ alias, provider: value.slice(0, slash), model: value.slice(slash + 1), ...(baseUrl !== undefined ? { baseUrl } : {}) });
    }
    // A base-URL override with no matching alias is a typo, not a silent no-op.
    const unmatched = [...baseUrls.keys()].filter((a) => !seen.has(a));
    if (unmatched.length > 0) throw new Error(`PLURNK_BASEURL_* override(s) with no matching PLURNK_MODEL_* alias: ${unmatched.join(", ")}. Declare the alias or remove the override.`);
    return out;
};

export const resolveActiveAlias = (env: NodeJS.ProcessEnv = process.env): ProviderAlias | null => {
    const selected = env.PLURNK_MODEL;
    if (selected === undefined || selected.length === 0) return null;
    const aliases = parseAliasesFromEnv(env);
    return aliases.find((a) => a.alias === selected.toLowerCase()) ?? null;
};
