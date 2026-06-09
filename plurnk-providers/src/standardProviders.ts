// Pure-config OpenAI-compatible providers. A provider qualifies as "standard"
// when it has no unique runtime surface — no catalog probe, no pricing fetch,
// no bespoke wire shape — so it reduces to: an env var for the key, a base
// URL, a reasoning-translation style, and a tokenizer. Such providers need NO
// sibling package; the framework instantiates them directly.
//
// Two-tier resolution (SPEC §5): the consumer tries standardProviderFromEnv
// first, then falls back to dynamic-importing @plurnk/plurnk-providers-<name>
// for the bespoke ones (openrouter, ollama, google, xai, cloudflare, ...).

import type { Provider } from "./types.ts";
import OpenAICompatProvider, { type ReasoningStyle } from "./OpenAICompat.ts";
import { parseRequiredInt, parseOptionalInt, requireEnv } from "./env.ts";
import { parseTokenizerFamily, tokenizerFor, type TokenizerFamily } from "./tokenizers.ts";

type StandardProviderSpec = {
    // API-key env var, and whether it's mandatory (local OpenAI-compat servers
    // run without auth, so the generic "openai" entry leaves it optional).
    apiKeyVar: string;
    apiKeyRequired: boolean;
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
    tokenizerDefault: TokenizerFamily;
    tokenizerEnvVar: string;
    // When true and PLURNK_PROVIDER_CONTEXT_SIZE is unset, probe GET /v1/models
    // for the endpoint-reported context window (`n_ctx`). Set for providers
    // that may front a local OpenAI-compat server (llama-server, vLLM, …) which
    // reports its loaded window there. Cloud endpoints don't report it → null.
    probeNctx?: boolean;
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
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "FIREWORKS_TOKENIZER",
    },
    deepinfra: {
        apiKeyVar: "DEEPINFRA_API_KEY", apiKeyRequired: true,
        baseUrl: "https://api.deepinfra.com/v1/openai", baseUrlVar: "DEEPINFRA_BASE_URL", chatPath: "/chat/completions",
        reasoningStyle: "none", tokenizerDefault: "heuristic", tokenizerEnvVar: "DEEPINFRA_TOKENIZER",
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

// Context-window resolution: PLURNK_PROVIDER_CONTEXT_SIZE → endpoint n_ctx
// (probe, opt-in per spec) → null. llama-server / vLLM report the loaded window
// as `n_ctx` on GET /v1/models; cloud endpoints don't, so the probe yields null
// there. Best-effort: any failure (unreachable, no field, non-2xx) → null,
// which is a legitimate "context unknown", not a swallowed contract violation.
const probeNctx = async (chatUrl: string, headers: Record<string, string>, model: string, fetchTimeoutMs: number): Promise<number | null> => {
    const modelsUrl = chatUrl.replace(/\/chat\/completions$/, "/models");
    try {
        const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(fetchTimeoutMs) });
        if (!res.ok) return null;
        const data = (await res.json()) as { data?: Array<{ id?: string; n_ctx?: number }> };
        const rows = data.data ?? [];
        const row = rows.find((r) => r.id === model) ?? rows[0];
        const n = row?.n_ctx;
        return typeof n === "number" && n > 0 ? n : null;
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

    const apiKey = spec.apiKeyRequired
        ? requireEnv(env[spec.apiKeyVar], spec.apiKeyVar, name)
        : env[spec.apiKeyVar] ?? "";

    const headers: Record<string, string> = {};
    if (apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;

    const family = parseTokenizerFamily(env[spec.tokenizerEnvVar], spec.tokenizerDefault, spec.tokenizerEnvVar, name);
    const url = resolveUrl(spec, env, name);
    const fetchTimeoutMs = parseRequiredInt(env.PLURNK_FETCH_TIMEOUT, "PLURNK_FETCH_TIMEOUT", name);

    // Explicit env wins; otherwise probe the endpoint when the spec opts in.
    let contextSize = parseOptionalInt(env.PLURNK_PROVIDER_CONTEXT_SIZE, "PLURNK_PROVIDER_CONTEXT_SIZE", name);
    if (contextSize === null && spec.probeNctx === true) {
        contextSize = await probeNctx(url, headers, model, fetchTimeoutMs);
    }

    return new OpenAICompatProvider({
        model,
        url,
        headers,
        contextSize,
        fetchTimeoutMs,
        reasonBudget: parseRequiredInt(env.PLURNK_REASON, "PLURNK_REASON", name),
        reasoningStyle: spec.reasoningStyle,
        countTokens: tokenizerFor(family),
    });
};
