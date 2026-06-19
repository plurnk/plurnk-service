// Pure-config OpenAI-compatible providers. A provider qualifies as "standard"
// when it has no unique runtime surface — no catalog probe, no pricing fetch,
// no bespoke wire shape — so it reduces to: an env var for the key, a base
// URL, a reasoning-translation style, and a tokenizer. Such providers need NO
// sibling package; the framework instantiates them directly.
//
// Two-tier resolution (SPEC §5): the consumer tries standardProviderFromEnv
// first, then falls back to the discover() node_modules scan for the bespoke
// ones (openrouter, ollama, google, xai, cloudflare, third-party). The scan
// resolves the package specifier — it is NOT a hardcoded @plurnk/ pattern.

import type { Provider, ProviderUsage } from "./types.ts";
import OpenAICompatProvider, { type ReasoningStyle, type GrammarStyle } from "./OpenAICompat.ts";
import { parseRequiredInt, parseOptionalInt, requireEnv, reasoningBudgetFromEnv } from "./env.ts";
import { parseTokenizerFamily, tokenizerFor, type TokenizerFamily } from "./tokenizers.ts";
import { providerSource } from "./telemetry.ts";
import { computeCost } from "./usage.ts";
import { lookup } from "@plurnk/plurnk-models";

type StandardProviderSpec = {
    // Single-var bearer auth, and whether it's mandatory (local OpenAI-compat
    // servers run without auth, so the generic "openai" entry leaves it
    // optional). Omit both when supplying a custom `headersFromEnv` builder.
    apiKeyVar?: string;
    apiKeyRequired?: boolean;
    // Custom request-header builder for auth the single-var bearer can't express
    // (multiple optional credentials, vendor routing headers). Returns the
    // headers built from env; an empty object means no auth headers are sent.
    // When set, it REPLACES the apiKeyVar bearer logic.
    headersFromEnv?: (env: NodeJS.ProcessEnv) => Record<string, string>;
    // Base URL: a fixed default and/or an operator override var. At least one
    // must resolve to a non-empty value.
    baseUrl?: string;
    baseUrlVar?: string;
    // Path appended to the (slash-trimmed) base to reach chat-completions.
    chatPath: string;
    // When true (generic "openai" only), strip a trailing /v1 from the
    // operator-supplied base before appending chatPath — the base may or may
    // not already include it.
    flexBaseStrip?: boolean;
    reasoningStyle: ReasoningStyle;
    // How this backend carries a GBNF grammar (default "none" — not sent). A
    // probeNctx entry is upgraded to "llamacpp" when the probe sees a
    // llama-server; cloud backends that support GBNF set their shape statically
    // (fireworks → "response_format", verified live).
    grammarStyle?: GrammarStyle;
    // SSE streaming (default true). The streaming transport is dropped
    // per-request only when it would break a feature (a response_format grammar
    // arrives mislabeled as reasoning_content under fireworks' stream); leave
    // unset to keep streaming on for every other call. See OpenAICompat.generate.
    streaming?: boolean;
    // Constant model-id prefix the backend requires but the alias shouldn't
    // repeat (fireworks → "accounts/fireworks/models/", so the alias is just
    // `fireworks/deepseek-v4-pro`). Prepended idempotently to form the wire id,
    // which is ALSO the catalog key (models.dev keys fireworks-ai on the full id).
    modelPrefix?: string;
    // First-party telemetry forwarding. ONLY the plurnk hosted endpoint sets
    // this — it forwards the consumer's per-turn `attributions` (contributor
    // credit) and `client` (originating frontend) as `Plurnk-Attribution` /
    // `Plurnk-Client` headers. Absent everywhere else, so those signals are
    // structurally incapable of reaching a third-party backend (never sold,
    // never leaked — the destination is the consent boundary).
    firstPartyMetadata?: boolean;
    tokenizerDefault: TokenizerFamily;
    tokenizerEnvVar: string;
    // When true, probe GET /v1/models at construction. Two reads off one call:
    // the endpoint-reported context window (`n_ctx`, used when
    // PLURNK_PROVIDER_CONTEXT_SIZE is unset) and the llama-server fingerprint
    // (a `meta` block on the model row) that enables grammar-constrained
    // sampling (SPEC §13). Set for providers that may front a local
    // OpenAI-compat server; cloud endpoints report neither → null / false.
    probeNctx?: boolean;
    // Whether a probeNctx spec may infer LOCAL llama-server capabilities (grammar
    // transport → "llamacpp", slot pinning, template reasoning) from the probe's
    // `meta` fingerprint. Default true. Set FALSE for an endpoint that reports a
    // window but must be treated as a plain remote OpenAI server — `plurnk` reads
    // its (server-controlled) window from upstream yet must NEVER be talked into
    // grammar/slot behavior, so its capabilities can't be flipped by what the
    // endpoint happens to return.
    detectLlamaServer?: boolean;
};

// Frozen so a downstream can't mutate the shared table.
export const STANDARD_PROVIDERS: Readonly<Record<string, StandardProviderSpec>> = Object.freeze({
    // Generic OpenAI-compatible endpoint (OpenAI proper, llama-server, vLLM,
    // LM Studio, or any chat-completions shim). Operator supplies the base.
    // Replaces the former @plurnk/plurnk-providers-openai sibling verbatim.
    openai: {
        apiKeyVar: "OPENAI_API_KEY", apiKeyRequired: false,
        baseUrlVar: "OPENAI_BASE_URL", chatPath: "/v1/chat/completions", flexBaseStrip: true,
        reasoningStyle: "think", tokenizerDefault: "heuristic", tokenizerEnvVar: "OPENAI_TOKENIZER",
        probeNctx: true,
    },
    groq: {
        apiKeyVar: "GROQ_API_KEY", apiKeyRequired: true,
        baseUrl: "https://api.groq.com/openai/v1", baseUrlVar: "GROQ_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "effort", tokenizerDefault: "heuristic", tokenizerEnvVar: "GROQ_TOKENIZER",
    },
    deepseek: {
        apiKeyVar: "DEEPSEEK_API_KEY", apiKeyRequired: true,
        baseUrl: "https://api.deepseek.com/v1", baseUrlVar: "DEEPSEEK_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "DEEPSEEK_TOKENIZER",
    },
    mistral: {
        apiKeyVar: "MISTRAL_API_KEY", apiKeyRequired: true,
        baseUrl: "https://api.mistral.ai/v1", baseUrlVar: "MISTRAL_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "MISTRAL_TOKENIZER",
    },
    together: {
        apiKeyVar: "TOGETHER_API_KEY", apiKeyRequired: true,
        baseUrl: "https://api.together.xyz/v1", baseUrlVar: "TOGETHER_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "TOGETHER_TOKENIZER",
    },
    fireworks: {
        apiKeyVar: "FIREWORKS_API_KEY", apiKeyRequired: true,
        baseUrl: "https://api.fireworks.ai/inference/v1", baseUrlVar: "FIREWORKS_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", grammarStyle: "response_format", modelPrefix: "accounts/fireworks/models/", tokenizerDefault: "heuristic", tokenizerEnvVar: "FIREWORKS_TOKENIZER",
    },
    deepinfra: {
        apiKeyVar: "DEEPINFRA_API_KEY", apiKeyRequired: true,
        baseUrl: "https://api.deepinfra.com/v1/openai", baseUrlVar: "DEEPINFRA_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "DEEPINFRA_TOKENIZER",
    },
    // First-party Claude via Anthropic's OpenAI-compat endpoint: bearer auth,
    // OpenAI SSE, the `thinking` reasoning param (reasoning_effort is ignored).
    // No probe — context/cost come from the @plurnk/plurnk-models catalog.
    anthropic: {
        apiKeyVar: "ANTHROPIC_API_KEY", apiKeyRequired: true,
        baseUrl: "https://api.anthropic.com/v1", baseUrlVar: "ANTHROPIC_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "anthropic", tokenizerDefault: "heuristic", tokenizerEnvVar: "ANTHROPIC_TOKENIZER",
    },
    // AWS Bedrock via its OpenAI-compat chat-completions endpoint, authed with a
    // Bedrock API key as a bearer token (SigV4 is optional, not required). The
    // base URL is region-templated, so the operator MUST set BEDROCK_BASE_URL
    // (e.g. https://bedrock-runtime.us-east-1.amazonaws.com/v1). Multi-model
    // relay (Claude, gpt-oss, Llama, …) → no single reasoning toggle. Model ids
    // are inference profiles like `us.anthropic.claude-sonnet-4-6`, which the
    // models.dev catalog does NOT key on — so bedrock has no catalog
    // context/cost; set PLURNK_PROVIDER_CONTEXT_SIZE for a context window (a
    // catalog inference-profile mapping is a deliberate follow-on, #19).
    bedrock: {
        apiKeyVar: "AWS_BEARER_TOKEN_BEDROCK", apiKeyRequired: true,
        baseUrlVar: "BEDROCK_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "BEDROCK_TOKENIZER",
    },
    // The plurnk hosted model — deliberately the most boring OpenAI-compatible
    // client we can ship. The open-source ecosystem must not know or care what
    // sits behind model.plurnk.ai (model, window, grammar, tuning are the
    // router's business). So: no reasoning param ("none"), an agnostic tokenizer
    // (heuristic), and NO grammar — the endpoint "doesn't support" GBNF here only
    // because the router injects its own. It DOES read its context window from
    // upstream (probeNctx), so a 32k→48k change is a one-line server decision,
    // never a client release — but `detectLlamaServer: false` keeps it a plain
    // remote OpenAI server that can't be flipped into grammar/slot behavior.
    // Base URL defaults to model.plurnk.ai, overridable via PLURNK_BASE_URL. Two
    // optional credentials: bearer PLURNK_KEY + the Plurnk-Account header, each
    // sent only when set. firstPartyMetadata forwards attribution/client headers.
    plurnk: {
        baseUrl: "https://model.plurnk.ai/v1", baseUrlVar: "PLURNK_BASE_URL", chatPath: "/chat/completions",
        headersFromEnv: (env) => {
            const h: Record<string, string> = {};
            const key = env.PLURNK_KEY ?? "";
            const account = env.PLURNK_ACCOUNT ?? "";
            if (key.length > 0) h.Authorization = `Bearer ${key}`;
            if (account.length > 0) h["Plurnk-Account"] = account;
            return h;
        },
        reasoningStyle: "none", grammarStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "PLURNK_TOKENIZER",
        probeNctx: true, detectLlamaServer: false, firstPartyMetadata: true,
    },
});

export const isStandardProvider = (name: string): boolean => name in STANDARD_PROVIDERS;

const resolveUrl = (spec: StandardProviderSpec, env: NodeJS.ProcessEnv, label: string): string => {
    const override = spec.baseUrlVar !== undefined ? env[spec.baseUrlVar] : undefined;
    const base = override !== undefined && override.length > 0 ? override : spec.baseUrl;
    if (base === undefined || base.length === 0) {
        throw new Error(`${label} provider: ${spec.baseUrlVar ?? "base URL"} must be set`);
    }
    const trimmed = spec.flexBaseStrip === true ? base.replace(/\/v1\/?$/, "") : base.replace(/\/$/, "");
    return `${trimmed}${spec.chatPath}`;
};

// Auth/routing headers. A custom builder (multi-credential auth) wins; otherwise
// the single-var bearer: required → fail-hard if unset, optional → omitted when
// blank (a keyless server then receives no Authorization header).
const resolveHeaders = (spec: StandardProviderSpec, env: NodeJS.ProcessEnv, label: string): Record<string, string> => {
    if (spec.headersFromEnv !== undefined) return spec.headersFromEnv(env);
    if (spec.apiKeyVar === undefined) return {};
    const apiKey = spec.apiKeyRequired === true
        ? requireEnv(env[spec.apiKeyVar], spec.apiKeyVar, label)
        : env[spec.apiKeyVar] ?? "";
    return apiKey.length > 0 ? { Authorization: `Bearer ${apiKey}` } : {};
};

// GET /v1/models probe. Yields the reported context window (llama-server nests
// it under `meta`, vLLM reports it top-level, cloud endpoints omit it) and the
// llama-server fingerprint — only llama-server rows carry a `meta` block, and
// llama-server is the backend whose chat-completions accepts a `grammar` field.
// Best-effort: any failure (unreachable, no field, non-2xx) degrades to
// { null, false } — a legitimate "unknown", not a swallowed contract violation.
type EndpointProbe = { nCtx: number | null; llamaServer: boolean };

const probeModels = async (chatUrl: string, headers: Record<string, string>, model: string, fetchTimeoutMs: number): Promise<EndpointProbe> => {
    const modelsUrl = chatUrl.replace(/\/chat\/completions$/, "/models");
    try {
        const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(fetchTimeoutMs) });
        if (!res.ok) return { nCtx: null, llamaServer: false };
        const data = (await res.json()) as { data?: Array<{ id?: string; n_ctx?: number; meta?: { n_ctx?: number } }> };
        const rows = data.data ?? [];
        const row = rows.find((r) => r.id === model) ?? rows[0];
        const n = row?.meta?.n_ctx ?? row?.n_ctx;
        return {
            nCtx: typeof n === "number" && n > 0 ? n : null,
            llamaServer: row?.meta !== undefined,
        };
    } catch {
        return { nCtx: null, llamaServer: false };
    }
};

// Slot count from llama-server's /props (total_slots) — the valid id_slot
// range for session pinning. Only queried after the llama-server fingerprint
// confirms; same best-effort posture as the models probe.
const probeSlotCount = async (chatUrl: string, headers: Record<string, string>, fetchTimeoutMs: number): Promise<number | null> => {
    const propsUrl = chatUrl.replace(/\/v1\/chat\/completions$/, "/props");
    try {
        const res = await fetch(propsUrl, { headers, signal: AbortSignal.timeout(fetchTimeoutMs) });
        if (!res.ok) return null;
        const data = (await res.json()) as { total_slots?: number };
        return typeof data.total_slots === "number" && data.total_slots > 0 ? data.total_slots : null;
    } catch {
        return null;
    }
};

// Returns a configured Provider, or null when `name` is not a standard
// provider (so the consumer falls through to dynamic import). Async because a
// probeNctx-enabled provider queries /v1/models at construction.
export const standardProviderFromEnv = async (name: string, env: NodeJS.ProcessEnv, model: string): Promise<Provider | null> => {
    const spec = STANDARD_PROVIDERS[name];
    if (spec === undefined) return null;

    // The on-the-wire model id: a backend-required constant prefix (fireworks)
    // prepended idempotently, so the operator's alias carries only the distinctive
    // tail. This id is what the backend, the probe, AND the catalog key on.
    const wireModel = spec.modelPrefix !== undefined && !model.startsWith(spec.modelPrefix)
        ? `${spec.modelPrefix}${model}`
        : model;

    const headers = resolveHeaders(spec, env, name);

    const family = parseTokenizerFamily(env[spec.tokenizerEnvVar], spec.tokenizerDefault, spec.tokenizerEnvVar, name);
    const url = resolveUrl(spec, env, name);
    const fetchTimeoutMs = parseRequiredInt(env.PLURNK_FETCH_TIMEOUT, "PLURNK_FETCH_TIMEOUT", name);

    // The probe always runs for probeNctx specs — grammar capability must not
    // hinge on whether the operator pinned PLURNK_PROVIDER_CONTEXT_SIZE. For
    // contextSize itself, explicit env still wins over the probed n_ctx.
    let contextSize = parseOptionalInt(env.PLURNK_PROVIDER_CONTEXT_SIZE, "PLURNK_PROVIDER_CONTEXT_SIZE", name);
    // Grammar shape: a static spec choice (e.g. fireworks → "response_format"),
    // upgraded to "llamacpp" when the probe fingerprints a llama-server. Slot
    // pinning is llama-server-only, so it keys on that same fingerprint. A spec
    // can opt out of the fingerprint entirely (detectLlamaServer: false → plurnk)
    // to read the window but stay a plain remote OpenAI server.
    let grammarStyle: GrammarStyle = spec.grammarStyle ?? "none";
    let supportsSlotPinning = false;
    let slotCount: number | null = null;
    let reasoningStyle = spec.reasoningStyle;
    if (spec.probeNctx === true) {
        const probe = await probeModels(url, headers, wireModel, fetchTimeoutMs);
        contextSize ??= probe.nCtx;
        if (probe.llamaServer && spec.detectLlamaServer !== false) {
            grammarStyle = "llamacpp";
            supportsSlotPinning = true;
            slotCount = await probeSlotCount(url, headers, fetchTimeoutMs);
            // llama-server ignores `think` — its working reasoning toggle is the
            // jinja chat_template_kwargs.enable_thinking, including the explicit
            // FALSE at budget 0 that grammar-constrained loops require (§13).
            if (reasoningStyle === "think") reasoningStyle = "template";
        }
    }

    // Vendored-snapshot FALLBACK (#19) — live always wins. contextSize already
    // preferred env then the live probe; the catalog only fills a still-null
    // window for a known cloud model (groq/deepseek/mistral/…, which don't
    // probe). A local llama-server model misses the catalog and keeps its
    // probed n_ctx. Standard providers carry NO live pricing, so the catalog is
    // the sole — never shadowing — cost source; per-1M USD → pico-USD/token (×1e6).
    const fallback = lookup(name, wireModel);
    contextSize ??= fallback?.contextWindow ?? null;
    const cost = fallback?.cost;
    const costFor = cost === undefined
        ? undefined
        : (usage: ProviderUsage): number => computeCost(usage, {
            input: cost.inputPer1M * 1e6,
            output: cost.outputPer1M * 1e6,
            cached: (cost.cacheReadPer1M ?? cost.inputPer1M) * 1e6,
        });

    return new OpenAICompatProvider({
        model: wireModel,
        url,
        headers,
        contextSize,
        fetchTimeoutMs,
        reasoningBudget: reasoningBudgetFromEnv(env, name),
        retryAttempts: parseRequiredInt(env.PLURNK_PROVIDER_RETRY_ATTEMPTS, "PLURNK_PROVIDER_RETRY_ATTEMPTS", name),
        reasoningStyle,
        countTokens: tokenizerFor(family),
        costFor,
        source: providerSource(name),
        grammarStyle,
        streaming: spec.streaming,
        firstPartyMetadata: spec.firstPartyMetadata,
        supportsSlotPinning,
        slotCount,
    });
};
