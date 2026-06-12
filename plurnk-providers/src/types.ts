// Provider transport contract. Providers return raw wire-level output —
// content unparsed (consumer parses via @plurnk/plurnk-grammar), reasoning
// is the wire-reported CoT only.

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

// Normalized token accounting. Invariant (enforced by normalizeUsage at the
// provider boundary): total = prompt + completion + reasoning; cached is a
// subset of prompt. `completion` is visible output EXCLUDING reasoning; the
// billable output is `completion + reasoning` (frontier providers bill thinking
// tokens at the output rate).
export interface ProviderUsage {
    readonly prompt: number;       // input tokens (cached ones included)
    readonly completion: number;   // visible output tokens, excluding reasoning
    readonly reasoning: number;    // reasoning/thinking tokens, billed as output
    readonly cached: number;       // subset of prompt served from cache
    readonly total: number;        // prompt + completion + reasoning
}

// Closed set per SPEC §2. Relay/aggregator providers MUST normalize wire
// values back to one of these at the provider boundary.
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;

export interface ProviderAssistant {
    readonly content: string;
    readonly reasoning: string | null;
    readonly usage: ProviderUsage;
    readonly finishReason: FinishReason;
    readonly model: string;
}

export interface ProviderResponse {
    readonly assistant: ProviderAssistant;
    readonly assistantRaw: unknown;
}

export interface Provider {
    // `grammar` is an optional GBNF string (canonically @plurnk/plurnk-grammar's
    // plurnk.gbnf, possibly root-substituted by the consumer). Backends that
    // support grammar-constrained sampling attach it verbatim; all others
    // ignore it. The provider never chooses or modifies the grammar — whether
    // to constrain and which root variant to send is consumer policy (SPEC §13).
    //
    // `maxTokens` is the consumer's per-call output ceiling (wire `max_tokens`).
    // Without it, most servers generate UNBOUNDED (llama-server n_predict -1) —
    // under a multi-op grammar that degenerates to the context wall (SPEC §13),
    // so a constrained consumer is expected to pass it. Policy stays the
    // consumer's; the provider only transports.
    //
    // `slotId` pins the request to a llama-server slot (wire `id_slot`) for
    // KV-cache affinity under `--parallel N>1` — without it, slot routing is
    // the server's similarity heuristic and a session's requests can hop slots,
    // re-paying full prefills. Backends without slot semantics ignore it
    // (cloud APIs 400 on unknown params, so it never reaches their wire).
    // Session→slot mapping is consumer policy; the provider only transports.
    generate(args: { messages: ChatMessage[]; signal?: AbortSignal; grammar?: string; maxTokens?: number; slotId?: number }): Promise<ProviderResponse>;
    // null = provider can't determine the model's context window. Consumer
    // treats null as "no budget info" — Percent column omitted rather than
    // guessed. Providers that always know contextSize never return null.
    // NOTE: under llama-server --parallel N, the window is PER SLOT (the
    // server splits --ctx-size across slots and reports the divided value).
    readonly contextSize: number | null;
    // Slot count for slot-pinning backends (llama-server /props total_slots);
    // null = backend has no slot semantics. Valid slotId range is [0, slotCount).
    readonly slotCount: number | null;
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
