// Provider transport contract. Providers return raw wire-level output —
// content unparsed (consumer parses via @plurnk/plurnk-contracts), reasoning
// is the wire-reported CoT only.

import type { ProviderNotice } from "./notices.ts";
import type { LanguageModel } from "ai";
import type {
    PluginAttribution,
    PluginAttributionContext,
    PluginAttributionSource,
} from "@plurnk/plurnk-meta";
import type {
    ProviderAccounting,
    ProviderCost,
    ProviderRequestAccounting,
    ProviderUsage,
} from "@plurnk/plurnk-contracts";

export type {
    ProviderAccounting,
    ProviderCost,
    ProviderRequestAccounting,
    ProviderUsage,
} from "@plurnk/plurnk-contracts";

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

// Preflight evidence for the complete provider request. An empirical estimate
// is useful telemetry but cannot authorize hard context-envelope admission.
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

export type ChargedCost = Extract<ProviderCost, { kind: "charged" }>;

// Evidence exposed by the transport to the provider adapter that owns its
// vendor protocol. Core and downstream consumers receive only the normalized
// charge, never a requirement to understand provider metadata fields.
export interface ProviderChargeEvidence {
    readonly providerMetadata?: unknown;
    // A protocol-owned direct monetary field. It remains unknown until the
    // selected adapter explicitly validates and normalizes it.
    readonly charge?: unknown;
    // Provider-owned raw usage projection retained independently of optional
    // full-body capture. Accounting fields cannot disappear merely because
    // forensic raw-body capture is disabled.
    readonly usage?: unknown;
    readonly response: {
        readonly id?: string;
        readonly headers?: Readonly<Record<string, string>>;
    };
}

export type ProviderCostNormalizer = (
    evidence: ProviderChargeEvidence,
) => ProviderCost | undefined;

export interface ProviderRequestIdentity {
    readonly provider: string;
    readonly model: string;
}

export type ProviderRequestSettlement = (
    accounting: ProviderRequestAccounting,
) => Promise<void>;

// Core opens durable physical-request identity through this observer before
// provider I/O. The returned settlement closes that exact identity.
export type ProviderRequestObserver = (
    identity: ProviderRequestIdentity,
) => Promise<ProviderRequestSettlement>;

// A successful exchange's closed finish set. ProviderAttemptFinishReason adds
// the failed disposition that may occur only on ProviderError attempt evidence.
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;
export type ProviderAttemptFinishReason = FinishReason | "resource_interrupted";

// {§provider-evidence} A per-token logprob. `logprob` is the backend's raw model
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

// {§provider-encrypted-reasoning} `id` is provider detail identity; `subtype`
// is the provider's evidence-backed classification. Neither is a client entity
// correlation, so consumers must not substitute `id` for a message/tool-call ID.
export interface ProviderEncryptedReasoningItem {
    readonly id: string | null;
    readonly subtype: string;
    readonly encrypted: ReadonlyArray<{ data: string; format: string | null }>;
}

export interface ProviderAssistant<TFinish extends ProviderAttemptFinishReason = FinishReason> {
    readonly content: string;
    readonly reasoning: string | null;
    // Encrypted reasoning remains distinct from readable `reasoning`.
    readonly reasoningEncrypted?: ReadonlyArray<ProviderEncryptedReasoningItem>;
    readonly finishReason: TFinish;
    readonly model: string;
    // Per-token logprobs, present only when PLURNK_PROVIDERS_TOP_LOGPROBS is set
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
    // Ordered physical request evidence, including automatic retries and pool
    // failover that preceded this response. {§provider-request-accounting}
    readonly accounting: readonly ProviderRequestAccounting[];
    // {§gbnf-response-observation} — evidence only; the consumer owns the verdict.
    readonly grammarEvidence?: GrammarEvidence;
    // Per-turn provider→client metadata bag: the backend's non-standard top-level
    // response fields passed through verbatim. Monetary values carry their own
    // amount and currency; the provider does not reinterpret them. The consumer
    // (service) merges this into its Turn metadata and
    // filters what reaches the client; it reads `meta`, never mines `assistantRaw`.
    // Absent when the backend reported no extra fields.
    readonly meta?: Record<string, unknown>;
    // The verbatim backend response body ({§provider-evidence}) — the full wire JSON for
    // a non-streamed turn, or the reassembled equivalent for a streamed one.
    // `assistantRaw` is a normalized DIGEST (it drops choices[]); this is the
    // capture-everything record for the endpoint's fine-tune corpus. Present ONLY
    // when PLURNK_PROVIDERS_RAWBODY is on — off by default so serving turns never
    // carry it. Absent otherwise.
    readonly rawBody?: unknown;
    // Notices attached to the represented attempt. Successful
    // returns may relay them; interrupted attempt notices remain forensic.
    // Grammar conformance itself is consumer-owned.
    readonly notices?: readonly ProviderNotice[];
}

export type ProviderAttempt = ProviderResponse<ProviderAttemptFinishReason>;

export interface Provider {
    // Optional package-authored folksonomy evaluated by the consumer immediately
    // before a provider emission attempt ({§plugin-attribution}).
    attributions?(context: PluginAttributionContext): PluginAttribution;
    // `grammar` is an optional GBNF string (canonically @plurnk/plurnk-contracts'
    // plurnk.gbnf, possibly root-substituted by the consumer). Backends that
    // support grammar-constrained sampling attach it verbatim; all others
    // ignore it. The provider never chooses or modifies the grammar — whether
    // to constrain and which root variant to send is consumer policy
    // ({§gbnf-response-observation}).
    //
    // `maxTokens` is the consumer's per-call output ceiling (wire `max_tokens`).
    // Without it, most servers generate UNBOUNDED (llama-server n_predict -1) —
    // under a multi-op grammar that degenerates to the context wall,
    // so a constrained consumer is expected to pass it. Policy stays the
    // consumer's; the provider only transports.
    //
    // `workerId` is the REQUIRED, opaque, stable identity of the consumer's work
    // stream (loop/run). Providers MAY key backend affinity on it — e.g.
    // llama-server slot pinning for KV-cache reuse — and MUST NOT interpret
    // its content. The consumer never sees or chooses backend resources
    // (slot integers, connections); the mechanism is the provider's.
    //
    // `attributions` is opaque consumer-supplied creator telemetry; the consumer
    // owns what contribution that set claims ({§attribution}). `client` is the
    // consumer's workspace-stable, self-identified frontend. They are forwarded ONLY by a
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
    // only and can't bypass grammar transport ({§provider-request-authority}). A
    // proxy consumer (the
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
    // `workspaceId`/`loop`/`turn` are the turn coordinate ({§lifecycle-terms}) — the
    // daemon-side sequence of the turn being generated, which the endpoint can
    // never scrape from the wire. Forwarded as `Plurnk-Workspace-Id`/`Plurnk-Loop`/
    // `Plurnk-Turn` ONLY under the same firstPartyMetadata gate; dropped
    // everywhere else. Coordinates are 1-based: absent/0 emits no header (no
    // strikes-style zero exception). Headers only, never the packet.
    generate(args: { messages: ChatMessage[]; workerId: string; primaryWorkerId?: string; signal?: AbortSignal; grammar?: string; maxTokens?: number; attributions?: string[]; client?: string; strikes?: number; workspaceId?: string; loop?: number; turn?: number; sampling?: Record<string, unknown>; observeRequest?: ProviderRequestObserver }): Promise<ProviderResponse>;
    // {§model-fact-resolution} — effective total context envelope in tokens,
    // including any stricter operator cap. `null` means unknown; under
    // llama-server parallelism the probed natural value is per slot.
    readonly contextWindow: number | null;
    readonly model: string;
    // Optional: the backend's self-reported served model id, from a
    // /v1/models-shaped probe (llama-server today; any such backend). For a local
    // alias, `model` is the alias but this is the real served name (the .gguf) the
    // tokenizer seam maps exactly. Read-only, best-effort, no extra probing —
    // absent when no probe ran. Consumers resolve `servedModel ?? model`.
    readonly servedModel?: string;
    // Optional resolved capability: true when a transported grammar will
    // actually constrain the decode (rails LIVE), false/undefined otherwise —
    // introspectable so the consumer can fail hard on a dark-rails boot instead
    // of discovering it from unconstrained emissions.
    readonly constrainsOutput?: boolean;
    // Optional resolved capability: true when this backend decodes
    // UNBOUNDED absent a caller cap — llama-server honors n_predict to the
    // context wall (observed in a 30,736-junk-token wall run), so a consumer
    // MUST bring an output envelope ({§provider-generation-envelope}). Cloud backends that silently
    // clamp an over-ask (fireworks/xai, verified live) never set this; undefined
    // = no claim. Introspectable so a consumer can refuse AT BOOT a local alias
    // with no declared envelope, instead of dying mid-turn in partition math.
    readonly requiresMaxTokens?: boolean;
    // Optional generation-envelope reserves ({§provider-generation-envelope}) — the amounts of
    // the effective window reserved for reasoning and completion: floor
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
    // Estimates are explicit and MUST NOT authorize hard context-envelope admission.
    countPromptTokens(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<PromptTokenMeasurement>;
    // OPTIONAL capability: exact tokenization served by the backend's own vocab
    // (llama-server /tokenize) — token ids in the model's real vocabulary.
    // Present ONLY when the backend exposes such an endpoint (probe-gated);
    // `tokenize === undefined` means the backend can't. Exact-counting
    // consumers (the tokenizer seam) prefer this over any client-side data.
    tokenize?(text: string): Promise<number[]>;
}

// ProviderAlias lives in @plurnk/plurnk-aliases (the zero-dependency parser);
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
export interface AiSdkProviderPlugin extends PluginAttributionSource {
    languageModel(model: string): LanguageModel;
}
