// Closed model families ship no declarations ({§provider-model-options}); these tests declare them as an
// operator routing one would.
const CLAUDE_ADAPTIVE = ["*claude-*"];
export const OPERATOR_MODEL_OPTIONS = Object.freeze({
    PLURNK_PROVIDERS_PROVIDER_ANTHROPIC_ADAPTIVE_OPTIONS: JSON.stringify([{ models: CLAUDE_ADAPTIVE, options: { anthropic: { thinking: { type: "adaptive", display: "summarized" } } } }]),
    PLURNK_PROVIDERS_PROVIDER_AMAZON_BEDROCK_ADAPTIVE_OPTIONS: JSON.stringify([{ models: CLAUDE_ADAPTIVE, options: { bedrock: { reasoningConfig: { type: "adaptive" } } } }]),
    PLURNK_PROVIDERS_PROVIDER_ANTHROPIC_SYSTEM_CACHE_OPTIONS: JSON.stringify([{ models: ["*"], options: { anthropic: { cacheControl: { type: "ephemeral" } } } }]),
    PLURNK_PROVIDERS_PROVIDER_OPENROUTER_SYSTEM_CACHE_OPTIONS: JSON.stringify([{ models: ["anthropic/*", "~anthropic/*"], options: { openrouter: { cacheControl: { type: "ephemeral" } } } }]),
});
