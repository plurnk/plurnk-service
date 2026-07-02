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
import { parseRequiredInt, parseOptionalInt, reasoningBudgetFromEnv } from "./env.ts";
import { parseTokenizerFamily, tokenizerFor, type TokenizerFamily } from "./tokenizers.ts";
import { providerSource } from "./telemetry.ts";
import { computeCost } from "./usage.ts";
import { lookup } from "@plurnk/plurnk-models";

type StandardProviderSpec = {
    // Bearer-auth env var(s), and whether the key is mandatory (local
    // OpenAI-compat servers run without auth, so the generic "openai" entry
    // leaves it optional). A LIST accepts the conventional aliases the wild uses
    // for one credential (e.g. deepinfra's API_KEY / API_TOKEN / TOKEN) — first
    // non-empty wins, the required-but-unset error names them all. Omit when
    // supplying a custom `headersFromEnv` builder.
    apiKeyVar?: string | readonly string[];
    apiKeyRequired?: boolean;
    // Custom request-header builder for auth the single-var bearer can't express
    // (multiple optional credentials, vendor routing headers). Returns the
    // headers built from env; an empty object means no auth headers are sent.
    // When set, it REPLACES the apiKeyVar bearer logic.
    headersFromEnv?: (env: NodeJS.ProcessEnv) => Record<string, string>;
    // Base URL env var(s) — REQUIRED, no in-code default (the endpoint is
    // operator config, declared uncommented in .env.example; a baked constant
    // would hide config from that file). A list accepts conventional aliases
    // (openai's BASE_URL / API_BASE). Either this or baseUrlFromEnv must resolve.
    baseUrlVar?: string | readonly string[];
    // Derive the base from env when no override var is set — for endpoints whose
    // URL is templated from standard env (bedrock builds it from AWS_REGION).
    // Throws a named error if it can't derive.
    baseUrlFromEnv?: (env: NodeJS.ProcessEnv) => string | undefined;
    // Custom catalog context-window resolver for a relay whose model id the
    // models.dev catalog doesn't key directly (bedrock inference profiles, #22).
    // Returns the model's context window or undefined. When set, the catalog COST
    // path is skipped — the model's native rate isn't this relay's rate.
    catalogContextLookup?: (model: string) => number | undefined;
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
    // Top-level response field the endpoint reports account balance (pico-USD) in,
    // surfaced as ProviderResponse.balancePico (plurnk only, #23). Absent elsewhere.
    balanceMetaKey?: string;
    tokenizerDefault: TokenizerFamily;
    tokenizerEnvVar: string;
    // When true, probe GET /v1/models at construction. Two reads off one call:
    // the endpoint-reported context window (`n_ctx`, used when
    // PLURNK_PROVIDERS_CONTEXT_SIZE is unset) and the llama-server fingerprint
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
        baseUrlVar: ["OPENAI_BASE_URL", "OPENAI_API_BASE"], chatPath: "/v1/chat/completions", flexBaseStrip: true,
        reasoningStyle: "think", tokenizerDefault: "heuristic", tokenizerEnvVar: "OPENAI_TOKENIZER",
        probeNctx: true,
    },
    groq: {
        apiKeyVar: "GROQ_API_KEY", apiKeyRequired: true,
        baseUrlVar: "GROQ_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "effort", tokenizerDefault: "heuristic", tokenizerEnvVar: "GROQ_TOKENIZER",
    },
    deepseek: {
        apiKeyVar: "DEEPSEEK_API_KEY", apiKeyRequired: true,
        baseUrlVar: "DEEPSEEK_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "DEEPSEEK_TOKENIZER",
    },
    mistral: {
        apiKeyVar: "MISTRAL_API_KEY", apiKeyRequired: true,
        baseUrlVar: "MISTRAL_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "MISTRAL_TOKENIZER",
    },
    together: {
        apiKeyVar: "TOGETHER_API_KEY", apiKeyRequired: true,
        baseUrlVar: "TOGETHER_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "TOGETHER_TOKENIZER",
    },
    // reasoningStyle "effort_explicit", NOT "none": fireworks serves reason-by-
    // DEFAULT models (DeepSeek V4 defaults 'high'), so budget 0 must SEND
    // reasoning_effort:"none" — omitting the field leaves the reasoner live inside
    // a constrained decode until max_tokens (#30; 0/5 → 30/30 measured).
    fireworks: {
        apiKeyVar: "FIREWORKS_API_KEY", apiKeyRequired: true,
        baseUrlVar: "FIREWORKS_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "effort_explicit", grammarStyle: "response_format", modelPrefix: "accounts/fireworks/models/", tokenizerDefault: "heuristic", tokenizerEnvVar: "FIREWORKS_TOKENIZER",
    },
    deepinfra: {
        apiKeyVar: ["DEEPINFRA_API_KEY", "DEEPINFRA_API_TOKEN", "DEEPINFRA_TOKEN"], apiKeyRequired: true,
        baseUrlVar: "DEEPINFRA_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "DEEPINFRA_TOKENIZER",
    },
    // — Chinese cloud hosts (all OpenAI-compat, plain bearer, doc-verified 2026). —
    // The .env.example base is the INTERNATIONAL endpoint; mainland operators
    // point the override var at the `.cn` twin noted per entry. Reasoning is left
    // "none" for the whole cohort: each host's thinking toggle is either
    // model-selected or a non-standard param that rides in `extra_body` (the
    // `effort`/`anthropic` styles don't reach it) — same posture as deepseek.
    // None are in the @plurnk/plurnk-models snapshot, so context comes from
    // PLURNK_PROVIDERS_CONTEXT_SIZE and cost stays unknown until the catalog adds
    // them (a plurnk-models issue, not this repo's).
    moonshot: {
        apiKeyVar: "MOONSHOT_API_KEY", apiKeyRequired: true,
        baseUrlVar: "MOONSHOT_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "MOONSHOT_TOKENIZER",
    },
    // Alibaba Qwen via DashScope "compatible-mode". Mainland: dashscope.aliyuncs.com.
    dashscope: {
        apiKeyVar: "DASHSCOPE_API_KEY", apiKeyRequired: true,
        baseUrlVar: "DASHSCOPE_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "DASHSCOPE_TOKENIZER",
    },
    // Zhipu GLM. Base carries /api/paas/v4 (non-/v1). Mainland: open.bigmodel.cn/api/paas/v4.
    zhipu: {
        apiKeyVar: ["ZHIPUAI_API_KEY", "ZAI_API_KEY"], apiKeyRequired: true,
        baseUrlVar: "ZHIPU_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "ZHIPU_TOKENIZER",
    },
    // ByteDance Doubao via BytePlus ModelArk (base carries /api/v3; `model` is an
    // inference-endpoint/model id). Mainland (Volcengine): ark.cn-beijing.volces.com/api/v3.
    volcengine: {
        apiKeyVar: "ARK_API_KEY", apiKeyRequired: true,
        baseUrlVar: "ARK_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "ARK_TOKENIZER",
    },
    // Tencent Hunyuan — single global host (no intl/mainland split).
    hunyuan: {
        apiKeyVar: "HUNYUAN_API_KEY", apiKeyRequired: true,
        baseUrlVar: "HUNYUAN_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "HUNYUAN_TOKENIZER",
    },
    // MiniMax. Mainland twin is api.minimaxi.com (note the extra "i").
    minimax: {
        apiKeyVar: "MINIMAX_API_KEY", apiKeyRequired: true,
        baseUrlVar: "MINIMAX_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "MINIMAX_TOKENIZER",
    },
    // StepFun. Intl twin is api.stepfun.ai (.ai vs the .com mainland host).
    stepfun: {
        apiKeyVar: "STEP_API_KEY", apiKeyRequired: true,
        baseUrlVar: "STEPFUN_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "STEPFUN_TOKENIZER",
    },
    // Baichuan — single host.
    baichuan: {
        apiKeyVar: "BAICHUAN_API_KEY", apiKeyRequired: true,
        baseUrlVar: "BAICHUAN_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "BAICHUAN_TOKENIZER",
    },
    // Baidu ERNIE via Qianfan v2 (key is a bce-v3/ALTAK-… bearer; base carries /v2).
    qianfan: {
        apiKeyVar: "QIANFAN_API_KEY", apiKeyRequired: true,
        baseUrlVar: "QIANFAN_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "QIANFAN_TOKENIZER",
    },
    // SiliconFlow aggregator. Mainland twin is api.siliconflow.cn.
    siliconflow: {
        apiKeyVar: "SILICONFLOW_API_KEY", apiKeyRequired: true,
        baseUrlVar: "SILICONFLOW_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "SILICONFLOW_TOKENIZER",
    },
    // ModelScope API-Inference aggregator — single host (.cn).
    modelscope: {
        apiKeyVar: ["MODELSCOPE_API_KEY", "MODELSCOPE_TOKEN"], apiKeyRequired: true,
        baseUrlVar: "MODELSCOPE_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "MODELSCOPE_TOKENIZER",
    },
    // First-party Claude via Anthropic's OpenAI-compat endpoint: bearer auth,
    // OpenAI SSE, the `thinking` reasoning param (reasoning_effort is ignored).
    // No probe — context/cost come from the @plurnk/plurnk-models catalog.
    anthropic: {
        apiKeyVar: "ANTHROPIC_API_KEY", apiKeyRequired: true,
        baseUrlVar: "ANTHROPIC_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "anthropic", tokenizerDefault: "heuristic", tokenizerEnvVar: "ANTHROPIC_TOKENIZER",
    },
    // AWS Bedrock via its OpenAI-compat endpoint (path is /openai/v1, NOT /v1),
    // bearer-authed with a Bedrock API key (SigV4 optional). Region-templated base
    // (see baseUrlFromEnv); model ids are inference profiles like
    // `us.anthropic.claude-sonnet-4-6` (see catalogContextLookup). Cost stays unknown —
    // bedrock marks up over the native rate, so set PLURNK_PROVIDERS_CONTEXT_SIZE for
    // a publisher the catalog lacks (#22).
    bedrock: {
        apiKeyVar: "AWS_BEARER_TOKEN_BEDROCK", apiKeyRequired: true,
        baseUrlVar: "BEDROCK_BASE_URL", chatPath: "/chat/completions",
        baseUrlFromEnv: (env) => {
            const region = firstSet(env, ["AWS_REGION", "AWS_DEFAULT_REGION"]);
            if (region === undefined) throw new Error("bedrock provider: BEDROCK_BASE_URL must be set, or AWS_REGION / AWS_DEFAULT_REGION to derive it");
            return `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
        },
        // Inference profile <region>.<publisher>.<model> — the catalog has no
        // `bedrock` provider, so strip the region scope and look the model up under
        // its PUBLISHER (anthropic, …). Only the context window rides; bedrock marks
        // up, so the native cost is NOT used (cost stays unknown, #22).
        catalogContextLookup: (model) => {
            const stripped = model.replace(/^(?:us-gov|us|eu|apac)\./, "");
            const dot = stripped.indexOf(".");
            if (dot < 0) return undefined;
            return lookup(stripped.slice(0, dot), stripped.slice(dot + 1))?.contextWindow;
        },
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "BEDROCK_TOKENIZER",
    },
    // The plurnk hosted model — deliberately the most boring OpenAI-compatible
    // client we can ship: the ecosystem must not know what sits behind
    // plurnk.ai (model/window/grammar/tuning are the router's business).
    // probeNctx reads the window from upstream (a 32k→48k change is a server
    // decision, not a client release), but detectLlamaServer:false keeps it a
    // plain remote server that can NOT be flipped into grammar/slot behavior.
    // PLURNK_API_KEY is an optional bearer (identifies the account server-side).
    plurnk: {
        baseUrlVar: "PLURNK_BASE_URL", chatPath: "/chat/completions",
        apiKeyVar: "PLURNK_API_KEY", apiKeyRequired: false,
        reasoningStyle: "none", grammarStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "PLURNK_TOKENIZER",
        probeNctx: true, detectLlamaServer: false, firstPartyMetadata: true, balanceMetaKey: "balance_pico",
    },
});

export const isStandardProvider = (name: string): boolean => name in STANDARD_PROVIDERS;

// Normalize a single-or-list env-var spec to a list, and return the first env
// var that is set non-empty (the accepted-alias resolution — first wins).
const asList = (v: string | readonly string[] | undefined): readonly string[] =>
    v === undefined ? [] : typeof v === "string" ? [v] : v;
const firstSet = (env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined => {
    for (const name of names) {
        const value = env[name];
        if (value !== undefined && value.length > 0) return value;
    }
    return undefined;
};

const resolveUrl = (spec: StandardProviderSpec, env: NodeJS.ProcessEnv, label: string, override?: string): string => {
    // per-alias override (PLURNK_BASEURL_<alias>) → base-URL var(s) → env-derived
    // template. No in-code default — the endpoint is required operator config.
    // The override goes through the same normalization (flexBaseStrip + chatPath),
    // so an operator pastes the box URL verbatim.
    const base = override ?? firstSet(env, asList(spec.baseUrlVar)) ?? spec.baseUrlFromEnv?.(env);
    if (base === undefined || base.length === 0) {
        const names = asList(spec.baseUrlVar);
        throw new Error(`${label} provider: ${names.length > 0 ? names.join(" or ") : "base URL"} must be set`);
    }
    const trimmed = spec.flexBaseStrip === true ? base.replace(/\/v1\/?$/, "") : base.replace(/\/$/, "");
    return `${trimmed}${spec.chatPath}`;
};

// Auth/routing headers. A custom builder (multi-credential auth) wins; otherwise
// the bearer from the first accepted alias that is set: required → fail-hard
// naming every accepted var, optional → omitted when none set (a keyless server
// then receives no Authorization header).
const resolveHeaders = (spec: StandardProviderSpec, env: NodeJS.ProcessEnv, label: string): Record<string, string> => {
    if (spec.headersFromEnv !== undefined) return spec.headersFromEnv(env);
    const names = asList(spec.apiKeyVar);
    if (names.length === 0) return {};
    const apiKey = firstSet(env, names);
    if (apiKey === undefined) {
        if (spec.apiKeyRequired === true) throw new Error(`${label} provider: ${names.join(" or ")} must be set`);
        return {};
    }
    return { Authorization: `Bearer ${apiKey}` };
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
export const standardProviderFromEnv = async (name: string, env: NodeJS.ProcessEnv, model: string, baseUrlOverride?: string): Promise<Provider | null> => {
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
    // A heuristic fallback is never silent: countTokens will be a chars/2 UPPER
    // BOUND, not an exact count — surfaced so the operator knows window math is
    // conservative until an exact tokenizer (family var, or the seam) is wired.
    if (family === "heuristic") {
        process.emitWarning(
            `${name} provider: no exact tokenizer for "${model}" — countTokens is a chars/2 upper bound (set ${spec.tokenizerEnvVar} for an exact family)`,
            { code: "PLURNK_TOKENIZER_HEURISTIC" },
        );
    }
    const url = resolveUrl(spec, env, name, baseUrlOverride);
    const fetchTimeoutMs = parseRequiredInt(env.PLURNK_FETCH_TIMEOUT, "PLURNK_FETCH_TIMEOUT", name);

    // The probe always runs for probeNctx specs — grammar capability must not
    // hinge on whether the operator pinned PLURNK_PROVIDERS_CONTEXT_SIZE. For
    // contextSize itself, explicit env still wins over the probed n_ctx.
    let contextSize = parseOptionalInt(env.PLURNK_PROVIDERS_CONTEXT_SIZE, "PLURNK_PROVIDERS_CONTEXT_SIZE", name);
    // Grammar shape: a static spec choice (e.g. fireworks → "response_format"),
    // upgraded to "llamacpp" when the probe fingerprints a llama-server. Slot
    // pinning is llama-server-only, so it keys on that same fingerprint. A spec
    // can opt out of the fingerprint entirely (detectLlamaServer: false → plurnk)
    // to read the window but stay a plain remote OpenAI server.
    let grammarStyle: GrammarStyle = spec.grammarStyle ?? "none";
    let supportsSlotPinning = false;
    let slotCount: number | null = null;
    let tokenizeUrl: string | undefined;
    let reasoningStyle = spec.reasoningStyle;
    if (spec.probeNctx === true) {
        const probe = await probeModels(url, headers, wireModel, fetchTimeoutMs);
        contextSize ??= probe.nCtx;
        if (probe.llamaServer && spec.detectLlamaServer !== false) {
            grammarStyle = "llamacpp";
            supportsSlotPinning = true;
            slotCount = await probeSlotCount(url, headers, fetchTimeoutMs);
            // llama-server serves its NATIVE /tokenize at the root (like /props):
            // the model's own vocab, exact — surfaced as the tokenize() capability.
            tokenizeUrl = url.replace(/\/v1\/chat\/completions$/, "/tokenize");
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
    // A relay with a catalogContextLookup (bedrock) resolves its window via the
    // underlying model's publisher and carries NO catalog cost (native rate ≠ relay
    // rate, #22); everyone else keys the catalog directly on (name, wireModel).
    const fallback = spec.catalogContextLookup === undefined ? lookup(name, wireModel) : undefined;
    contextSize ??= (spec.catalogContextLookup !== undefined ? spec.catalogContextLookup(wireModel) : fallback?.contextWindow) ?? null;
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
        retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", name),
        reasoningStyle,
        countTokens: tokenizerFor(family),
        costFor,
        source: providerSource(name),
        grammarStyle,
        // Optional debug toggle (off by default): validate a transported grammar
        // locally and throw on invalid, without sending it to the model (§13).
        gbnfDebug: env.PLURNK_GBNF_DEBUG !== undefined && env.PLURNK_GBNF_DEBUG !== "" && env.PLURNK_GBNF_DEBUG !== "0",
        streaming: spec.streaming,
        firstPartyMetadata: spec.firstPartyMetadata,
        balanceMetaKey: spec.balanceMetaKey,
        supportsSlotPinning,
        slotCount,
        tokenizeUrl,
    });
};
