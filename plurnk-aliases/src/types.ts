// The resolved alias-cascade entry. One per PLURNK_MODEL_<alias>=<provider>/<model>
// var, with an optional per-alias endpoint override from PLURNK_BASEURL_<alias>.
export interface ProviderAlias {
    readonly alias: string;     // lowercase, .env key suffix downcased
    readonly provider: string;  // "openai", "openrouter", "ollama", etc.
    readonly model: string;     // provider-native id; may contain "/"
    readonly baseUrl?: string;  // PLURNK_BASEURL_<alias>: per-alias endpoint override (local boxes)
}
