// Provider transport contract. Providers return raw wire-level output —
// content unparsed (consumer parses via @plurnk/plurnk-grammar), reasoning
// is the wire-reported CoT only.

import type { TelemetryEvent } from "./telemetry.ts";

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
    // Per-turn provider→client metadata bag: the backend's non-standard top-level
    // response fields, passed through verbatim, PLUS validated known keys we hold a
    // contract for (e.g. `balancePico` — a finite pico-USD number, from the plurnk
    // endpoint). The consumer (service) merges this into its Turn metadata and
    // filters what reaches the client; it reads `meta`, never mines `assistantRaw`.
    // Absent when the backend reported no extra fields (#23, generalized).
    readonly meta?: Record<string, unknown>;
    // Non-fatal provider telemetry attached to a SUCCESSFUL turn (#24). The model's
    // bytes still flow through `assistant`; these events annotate them. Today: a
    // `grammar_unenforced` event raised in GBNF-filter mode (PLURNK_GBNF_DEBUG —
    // grammar withheld, output validated after the fact) carrying the divergence
    // `position` so the consumer can render the model its own emission and let it
    // self-correct, instead of the provider throwing and discarding the turn. The
    // constrained path still THROWS a grammar_unenforced ProviderError (a backend
    // that was sent a grammar and ignored it is a hard failure, SPEC §13). Absent
    // when the turn produced no telemetry.
    readonly telemetry?: readonly TelemetryEvent[];
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

// ProviderAlias moved to @plurnk/plurnk-aliases (the zero-dep parser, #27);
// index.ts re-exports it so the "." surface is unchanged.

// Per-alias instantiation overrides, threaded from the alias cascade into the
// factory. `baseUrl` lets two aliases on the SAME provider name (openai, ollama)
// target DIFFERENT endpoints — the only way to run N self-hosted boxes, since the
// provider's own base-URL env var binds one URL per name. Absent → the provider
// resolves its base from its env var as before.
export interface ProviderOptions {
    readonly baseUrl?: string;
}

// Each provider package's default export MUST be a factory:
//   static fromEnv(env, model, options?) → Provider | Promise<Provider>
// `model` is the second positional arg because PLURNK_MODEL_<alias>=<provider>/<model>
// is parsed by the registry; the resolved model id flows through. `options` is an
// optional third arg (per-alias overrides, e.g. baseUrl); a factory that ignores
// it keeps working unchanged.
export interface ProviderFactory {
    fromEnv(env: NodeJS.ProcessEnv, model: string, options?: ProviderOptions): Provider | Promise<Provider>;
}
