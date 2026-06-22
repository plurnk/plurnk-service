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
    // Provider→client account balance in pico-USD (matches cost units), when the
    // backend reports it per response. ONLY the plurnk hosted endpoint populates
    // this; every other provider omits it (undefined) — same null-honest contract
    // as contextSize. The consumer must NOT mine assistantRaw for it (SPEC §2/#23).
    readonly balancePico?: number;
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
    // `runId` is the REQUIRED, opaque, stable identity of the consumer's work
    // stream (loop/run). Providers MAY key backend affinity on it — e.g.
    // llama-server slot pinning for KV-cache reuse — and MUST NOT interpret
    // its content. The consumer never sees or chooses backend resources
    // (slot integers, connections); the *mechanism* is the provider's (#11).
    //
    // `attributions` (per-turn, runtime-observed) and `client` (session-stable,
    // self-identified) are first-party telemetry the consumer hands down: which
    // installed plugin packages dispatched this turn, and which frontend
    // originated the run. They are forwarded ONLY by a provider whose spec opts
    // in (the first-party `plurnk` endpoint, via `Plurnk-Attribution` /
    // `Plurnk-Client` headers); every other provider DROPS them — the gate is
    // structural so first-party metadata can never leak to a third-party backend.
    generate(args: { messages: ChatMessage[]; runId: string; signal?: AbortSignal; grammar?: string; maxTokens?: number; attributions?: string[]; client?: string }): Promise<ProviderResponse>;
    // null = provider can't determine the model's context window. Consumer
    // treats null as "no budget info" — Percent column omitted rather than
    // guessed. Providers that always know contextSize never return null.
    // NOTE: under llama-server --parallel N, the window is PER SLOT (the
    // server splits --ctx-size across slots and reports the divided value).
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
