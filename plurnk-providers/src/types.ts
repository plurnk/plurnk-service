// Provider transport contract. Providers return raw wire-level output —
// content unparsed (consumer parses via @plurnk/plurnk-grammar), reasoning
// is the wire-reported CoT only.

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface ProviderUsage {
    readonly prompt: number;
    readonly completion: number;
    readonly cached: number;
    readonly total: number;
}

export interface ProviderAssistant {
    readonly content: string;
    readonly reasoning: string | null;
    readonly usage: ProviderUsage;
    readonly finishReason: string | null;
    readonly model: string;
}

export interface ProviderResponse {
    readonly assistant: ProviderAssistant;
    readonly assistantRaw: unknown;
}

export interface Provider {
    generate(args: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse>;
    // null = provider can't determine the model's context window. Consumer
    // treats null as "no budget info" — Percent column omitted rather than
    // guessed. Providers that always know contextSize never return null.
    readonly contextSize: number | null;
    readonly model: string;
    // Provider-owned tokenizer. Synchronous, non-negative integer.
    countTokens(text: string): number;
    // Provider-owned cost calculation. Returns pico-USD (1e-12 USD).
    // Returns 0 for siblings/models with no known rates.
    costFor(usage: ProviderUsage): number;
}

export interface ProviderAlias {
    readonly alias: string;     // lowercase, .env key suffix downcased
    readonly provider: string;  // "openai", "openrouter", "ollama", etc.
    readonly model: string;     // provider-native id; may contain "/"
}

// Each provider package's default export MUST be a factory:
//   static fromEnv(env, model) → Provider | Promise<Provider>
// `model` is the second positional arg because PLURNK_MODEL_<alias>=<provider>/<model>
// is parsed by the registry; the resolved model id flows through.
export interface ProviderFactory {
    fromEnv(env: NodeJS.ProcessEnv, model: string): Provider | Promise<Provider>;
}
