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
// billable output is `completion + reasoning` (frontier providers bill reasoning
// tokens at the output rate).
export interface ProviderUsage {
    readonly prompt: number;       // input tokens (cached ones included)
    readonly completion: number;   // visible output tokens, excluding reasoning
    readonly reasoning: number;    // reasoning tokens, billed as output
    readonly cached: number;       // subset of prompt served from cache
    readonly total: number;        // prompt + completion + reasoning
}

// Closed set per SPEC §2. Relay/aggregator providers MUST normalize wire
// values back to one of these at the provider boundary.
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;

// A per-token logprob (#36, SPEC §14). `logprob` is the backend's RAW model
// log-probability of the emitted token — the sampling-transform-invariant
// confidence, chosen over Fireworks' post-mask `sampling_logprob` (measured
// IDENTICAL under grammar, incl. an adversarial mask; the raw value is the honest
// model belief and the correct distillation target). `top` carries the top-N
// alternatives when top_logprobs was requested. The verbatim per-token record
// (sampling_logprob, token_id, bytes, mask fields) survives on
// ProviderResponse.rawBody — this structured view is the canonical signal only.
export interface TokenAlternative {
    readonly token: string;
    readonly logprob: number;
}
export interface TokenLogprob {
    readonly token: string;
    readonly logprob: number;
    readonly top?: readonly TokenAlternative[];
}

export interface ProviderAssistant {
    readonly content: string;
    readonly reasoning: string | null;
    // Sealed reasoning (#482): a relay backend (OpenRouter fronting OpenAI
    // o-series) returns the chain-of-thought ENCRYPTED — surfaced verbatim as
    // { data, format } blobs, never decoded, never synthesized. Readable text
    // stays on `reasoning`. Absent when the turn produced none; consumers (agui)
    // project it as REASONING_ENCRYPTED_VALUE.
    readonly reasoningEncrypted?: ReadonlyArray<{ data: string; format: string | null }>;
    readonly usage: ProviderUsage;
    readonly finishReason: FinishReason;
    readonly model: string;
    // Per-token logprobs (#36), present ONLY when PLURNK_PROVIDERS_TOP_LOGPROBS is set
    // AND the backend returned them. Absent otherwise — NEVER synthesized. Opt-in,
    // per-alias: a scraping alias enables it; serving turns carry nothing.
    readonly logprobs?: readonly TokenLogprob[];
    // Convenience: mean of logprobs[].logprob (natural log). Absent when logprobs is.
    readonly meanLogprob?: number;
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
    // The VERBATIM backend response body (#36, SPEC §14) — the full wire JSON for
    // a non-streamed turn, or the reassembled equivalent for a streamed one.
    // `assistantRaw` is a normalized DIGEST (it drops choices[]); this is the
    // capture-everything record for the endpoint's fine-tune corpus. Present ONLY
    // when PLURNK_PROVIDERS_RAWBODY is on — off by default so serving turns never
    // carry it. Absent otherwise.
    readonly rawBody?: unknown;
    // Observations attached to a COMPLETED exchange (#24, SPEC §13). The model's
    // bytes always flow through `assistant`; these events annotate them. Today: a
    // `grammar_unenforced` event whenever the output diverges from the grammar —
    // transported OR withheld (filter mode) — carrying the divergence `position`.
    // The provider never adjudicates conformance; discard/retry/escalate/
    // self-correct is consumer policy. Absent when the turn produced no telemetry.
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
    // `workerId` is the REQUIRED, opaque, stable identity of the consumer's work
    // stream (loop/run). Providers MAY key backend affinity on it — e.g.
    // llama-server slot pinning for KV-cache reuse — and MUST NOT interpret
    // its content. The consumer never sees or chooses backend resources
    // (slot integers, connections); the *mechanism* is the provider's (#11).
    //
    // `attributions` (per-turn, runtime-observed) and `client` (workspace-stable,
    // self-identified) are first-party telemetry the consumer hands down: which
    // installed plugin packages dispatched this turn, and which frontend
    // originated the worker. They are forwarded ONLY by a provider whose spec opts
    // in (the first-party `plurnk` endpoint, via `Plurnk-Attribution` /
    // `Plurnk-Client` headers); every other provider DROPS them — the gate is
    // structural so first-party metadata can never leak to a third-party backend.
    //
    // `sampling` is an optional bag of standard OpenAI-compat sampling params
    // (temperature, top_p, top_k, min_p, penalties, stop, seed, …) forwarded into
    // the request body UNDER the provider's managed fields — model/messages/grammar/
    // reasoning/max_tokens/slot always win, and transport/protocol keys (stream,
    // response_format, grammar, id_slot) are stripped, so it carries sampling intent
    // only and can't bypass grammar transport (SPEC §8 holds). A PROXY consumer (the
    // plurnk endpoint fronting its own backends) uses it to pass its caller's sampling
    // knobs through; a direct consumer typically leaves it unset.
    //
    // `strikes` is the worker's CURRENT rail-strike streak at time-of-generate
    // (0 = clean; a clean turn zeroes it; every loop starts at 0 — contract:
    // plurnk-service#313). Forwarded as a `Plurnk-Strikes` header ONLY under the
    // same firstPartyMetadata gate as attributions/client; dropped everywhere
    // else. Headers only — the packet NEVER carries strike state (the model must
    // not see engine accounting; it would become a metric to game).
    //
    // `workspaceId`/`loop`/`turn` (#404, per #391) are the turn COORDINATE — the
    // daemon-side sequence of the turn being generated, which the endpoint can
    // never scrape from the wire. Forwarded as `Plurnk-Workspace-Id`/`Plurnk-Loop`/
    // `Plurnk-Turn` ONLY under the same firstPartyMetadata gate; dropped
    // everywhere else. Coordinates are 1-based: absent/0 emits no header (no
    // strikes-style zero exception). Headers only, never the packet.
    generate(args: { messages: ChatMessage[]; workerId: string; signal?: AbortSignal; grammar?: string; maxTokens?: number; attributions?: string[]; client?: string; strikes?: number; workspaceId?: string; loop?: number; turn?: number; sampling?: Record<string, unknown> }): Promise<ProviderResponse>;
    // The model's context window in tokens. The provider RESOLVES it (operator pin
    // -> live probe -> @plurnk/plurnk-models catalog). A CLOUD provider (no probe)
    // FAILS AT CONSTRUCTION when it can't (#419/#417: never budget against a wrong
    // number). A PROBING provider (openai/llama-server) instead DEGRADES to null on a
    // probe miss - a blip must not crash it (#34) - and surfaces it once
    // (PLURNK_CONTEXT_UNKNOWN). So null still means "window unknown -> no cap"; the
    // consumer must NOT improvise a stand-in from it (#421). NOTE: under llama-server
    // --parallel N, the window is PER SLOT (the server splits --ctx-size across slots
    // and reports the divided value).
    readonly contextWindow: number | null;
    readonly model: string;
    // OPTIONAL (#37): the backend's SELF-REPORTED served model id, from a
    // /v1/models-shaped probe (llama-server today; any such backend). For a local
    // alias, `model` is the alias but this is the real served name (the .gguf) the
    // tokenizer seam maps exactly. Read-only, best-effort, no extra probing —
    // absent when no probe ran. Consumers resolve `servedModel ?? model`.
    readonly servedModel?: string;
    // OPTIONAL resolved capability (#34): true when a transported grammar will
    // actually constrain the decode (rails LIVE), false/undefined otherwise —
    // introspectable so the consumer can fail hard on a dark-rails boot instead
    // of discovering it from unconstrained emissions.
    readonly constrainsOutput?: boolean;
    // OPTIONAL resolved capability (#43): true when this backend decodes
    // UNBOUNDED absent a caller cap — llama-server honors n_predict to the
    // context wall (the 30,736-junk-token wall-run, providers#10), so a consumer
    // MUST bring an output envelope (SPEC §13). Cloud backends that silently
    // clamp an over-ask (fireworks/xai, verified live) never set this; undefined
    // = no claim. Introspectable so a consumer can refuse AT BOOT a local alias
    // with no declared envelope, instead of dying mid-turn in partition math.
    readonly requiresMaxTokens?: boolean;
    // OPTIONAL generation-envelope reserves (#507, owner-ruled) — the amounts OF
    // the DETECTED window reserved for reasoning and completion: floor
    // percentages of `contextWindow`, or absolute per-alias pins that win
    // outright. The consumer's prompt budget is `contextWindow - reasoningReserve
    // - completionReserve - <its own packing-safety margin>`; the generation cap
    // is the two pooled. `null` = underivable (window unknown, no absolute pin) →
    // the consumer's no-cap path. Absent = a bare sibling makes NO claim (treated
    // as null). All first-party providers claim, so null means genuinely-unknown.
    readonly reasoningReserve?: number | null;
    readonly completionReserve?: number | null;
    // Provider-owned tokenizer. Synchronous, non-negative integer. Without an
    // exact family configured this is the chars/2 UPPER BOUND (surfaced at
    // construction, never silent) — safe for refusal math, not an exact count.
    countTokens(text: string): number;
    // OPTIONAL capability: exact tokenization served by the backend's own vocab
    // (llama-server /tokenize) — token ids in the model's real vocabulary.
    // Present ONLY when the backend exposes such an endpoint (probe-gated);
    // `tokenize === undefined` means the backend can't. Exact-counting
    // consumers (the tokenizer seam) prefer this over any client-side data.
    tokenize?(text: string): Promise<number[]>;
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
