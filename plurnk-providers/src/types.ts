// Provider transport contract. Providers return raw wire-level output —
// content unparsed (consumer parses via @plurnk/plurnk-contracts), reasoning
// is the wire-reported CoT only.

import type { ProviderNotice } from "./notices.ts";
import type { LanguageModel } from "ai";

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

// Preflight evidence for the complete provider request. An empirical estimate
// is useful telemetry but cannot authorize a hard physical-capacity decision.
export type PromptTokenMeasurement =
    | {
        readonly kind: "exact" | "upper_bound";
        readonly tokens: number;
        readonly source: string;
    }
    | {
        readonly kind: "estimate";
        readonly tokens: number;
        readonly source: string;
        readonly detail: string;
    };

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

// A successful exchange's closed finish set. ProviderAttemptFinishReason adds
// the failed disposition that may occur only on ProviderError attempt evidence.
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;
export type ProviderAttemptFinishReason = FinishReason | "resource_interrupted";

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

export interface ProviderAssistant<TFinish extends ProviderAttemptFinishReason = FinishReason> {
    readonly content: string;
    readonly reasoning: string | null;
    // Encrypted reasoning remains distinct from readable `reasoning`; #44 owns
    // the provider-boundary identity/subtype normalization rule.
    readonly reasoningEncrypted?: ReadonlyArray<{ id: string | null; subtype: string; encrypted: ReadonlyArray<{ data: string; format: string | null }> }>;
    readonly usage: ProviderUsage;
    readonly finishReason: TFinish;
    readonly model: string;
    // Per-token logprobs (#36), present ONLY when PLURNK_PROVIDERS_TOP_LOGPROBS is set
    // AND the backend returned them. Absent otherwise — NEVER synthesized. Opt-in,
    // per-alias: a scraping alias enables it; serving turns carry nothing.
    readonly logprobs?: readonly TokenLogprob[];
    // Convenience: mean of logprobs[].logprob (natural log). Absent when logprobs is.
    readonly meanLogprob?: number;
}

export interface GrammarEvidence {
    // Exact sentence observed at the grammar boundary before any reasoning/content
    // projection. Offsets are Unicode code points, matching @plurnk/gbnf verdicts.
    readonly input: string;
    readonly contentStart: number;
    readonly transported: boolean;
}

export interface ProviderResponse<TFinish extends ProviderAttemptFinishReason = FinishReason> {
    readonly assistant: ProviderAssistant<TFinish>;
    readonly assistantRaw: unknown;
    // {§gbnf-response-observation} — evidence only; the consumer owns the verdict.
    readonly grammarEvidence?: GrammarEvidence;
    // Per-turn provider→client metadata bag: the backend's non-standard top-level
    // response fields passed through verbatim. Monetary values carry their own
    // amount and currency; the provider does not reinterpret them. The consumer
    // (service) merges this into its Turn metadata and
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
    // Notices attached to the represented attempt (#24, SPEC §13). Successful
    // returns may relay them; interrupted attempt notices remain forensic.
    // Grammar conformance itself is consumer-owned.
    readonly notices?: readonly ProviderNotice[];
}

export type ProviderAttempt = ProviderResponse<ProviderAttemptFinishReason>;

export interface Provider {
    // `grammar` is an optional GBNF string (canonically @plurnk/plurnk-contracts'
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
    // `attributions` is opaque consumer-supplied creator telemetry; the consumer
    // owns what contribution that set claims (#81). `client` is the consumer's
    // workspace-stable, self-identified frontend. They are forwarded ONLY by a
    // provider whose spec opts in (the first-party `plurnk` endpoint, via
    // `Plurnk-Attribution` / `Plurnk-Client` headers); every other provider DROPS
    // them — the gate is structural so first-party metadata can never leak to a
    // third-party backend.
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
    // (0 = clean; a clean turn zeroes it; every loop starts at 0 — contract
    // {§strikes-first-party-metadata}). Forwarded as a `Plurnk-Strikes` header ONLY under the
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
    generate(args: { messages: ChatMessage[]; workerId: string; primaryWorkerId?: string; signal?: AbortSignal; grammar?: string; maxTokens?: number; attributions?: string[]; client?: string; strikes?: number; workspaceId?: string; loop?: number; turn?: number; sampling?: Record<string, unknown> }): Promise<ProviderResponse>;
    // {§model-fact-resolution} — effective physical context in tokens. `null`
    // means unknown; under llama-server parallelism the probed value is per slot.
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
    // context wall (observed in a 30,736-junk-token wall run), so a consumer
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
    // Provider-owned preflight measurement of the complete chat request,
    // including provider/template framing when the adapter can know it.
    // Estimates are explicit and MUST NOT authorize hard physical admission.
    countPromptTokens(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<PromptTokenMeasurement>;
    // OPTIONAL capability: exact tokenization served by the backend's own vocab
    // (llama-server /tokenize) — token ids in the model's real vocabulary.
    // Present ONLY when the backend exposes such an endpoint (probe-gated);
    // `tokenize === undefined` means the backend can't. Exact-counting
    // consumers (the tokenizer seam) prefer this over any client-side data.
    tokenize?(text: string): Promise<number[]>;
    // {§model-fact-resolution} — local USD estimate. The current surface returns
    // 0 for both unknown rates and a genuine zero estimate; #9 owns that split.
    calculateCost(usage: ProviderUsage): number;
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

// A discovered provider plugin default-exports an AI SDK provider. PLURNK owns
// the adapter into Provider; the plugin owns only its protocol binding.
export interface AiSdkProviderPlugin {
    languageModel(model: string): LanguageModel;
}
