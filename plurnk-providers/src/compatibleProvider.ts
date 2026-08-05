import AiSdkProvider, { type GrammarStyle, type ReasoningStyle } from "./AiSdkProvider.ts";
import {
    contextWindowFromEnv,
    effectiveContextWindow,
    dataCaptureFromEnv,
    envelopeFromEnv,
    parseOptionalFloat,
    parseOptionalInt,
    parseRequiredFloat,
    parseRequiredInt,
    promptCacheKeyFromEnv,
    reasoningFromEnv,
    reasoningResponseStyleFromEnv,
} from "./env.ts";
import { providerSource } from "./notices.ts";
import type { Provider } from "./types.ts";
import { emitWarningOnce } from "./warnings.ts";

type EndpointProbe = {
    nCtx: number | null;
    llamaServer: boolean;
    servedModel: string | null;
    failed: boolean;
};

const chatUrl = (
    provider: "openai" | "plurnk",
    env: NodeJS.ProcessEnv,
    override?: string,
): string => {
    const configured = override
        ?? (provider === "openai"
            ? env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE
            : env.PLURNK_BASE_URL);
    if (configured === undefined || configured.length === 0) {
        throw new Error(`${provider} provider: ${provider === "openai" ? "OPENAI_BASE_URL or OPENAI_API_BASE" : "PLURNK_BASE_URL"} must be set`);
    }
    const base = configured.replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) return base;
    if (provider === "openai") return `${base.replace(/\/v1$/, "")}/v1/chat/completions`;
    return `${base}/chat/completions`;
};

const probeModels = async (
    url: string,
    headers: Record<string, string>,
    model: string,
    timeout: number,
): Promise<EndpointProbe> => {
    const modelsUrl = url.replace(/\/chat\/completions$/, "/models");
    try {
        const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(timeout) });
        if (!response.ok) return { nCtx: null, llamaServer: false, servedModel: null, failed: true };
        const data = await response.json() as {
            data?: Array<{ id?: string; n_ctx?: number; meta?: { n_ctx?: number } }>;
        };
        const rows = data.data ?? [];
        const row = rows.find((candidate) => candidate.id === model) ?? rows[0];
        const nCtx = row?.meta?.n_ctx ?? row?.n_ctx;
        return {
            nCtx: typeof nCtx === "number" && nCtx > 0 ? nCtx : null,
            llamaServer: row?.meta !== undefined,
            servedModel: typeof row?.id === "string" && row.id.length > 0 ? row.id : null,
            failed: false,
        };
    } catch {
        return { nCtx: null, llamaServer: false, servedModel: null, failed: true };
    }
};

const probeModelsRetrying = async (
    url: string,
    headers: Record<string, string>,
    model: string,
    timeout: number,
    attempts: number,
    delay: number,
): Promise<EndpointProbe> => {
    let result: EndpointProbe = { nCtx: null, llamaServer: false, servedModel: null, failed: true };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delay * 2 ** (attempt - 1)));
        result = await probeModels(url, headers, model, timeout);
        if (!result.failed) return result;
    }
    return result;
};

const probeProps = async (
    url: string,
    headers: Record<string, string>,
    timeout: number,
): Promise<{ slotCount: number | null; eosText: string | null }> => {
    try {
        const response = await fetch(url.replace(/\/v1\/chat\/completions$/, "/props"), {
            headers,
            signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) return { slotCount: null, eosText: null };
        const data = await response.json() as { total_slots?: number; eos_token?: string };
        return {
            slotCount: typeof data.total_slots === "number" && data.total_slots > 0 ? data.total_slots : null,
            eosText: typeof data.eos_token === "string" && data.eos_token.length > 0 ? data.eos_token : null,
        };
    } catch {
        return { slotCount: null, eosText: null };
    }
};

export const compatibleProviderFromEnv = async (
    provider: "openai" | "plurnk",
    env: NodeJS.ProcessEnv,
    model: string,
    baseUrlOverride?: string,
): Promise<Provider> => {
    const url = chatUrl(provider, env, baseUrlOverride);
    const apiKey = provider === "openai" ? env.OPENAI_API_KEY : env.PLURNK_API_KEY;
    const headers: Record<string, string> = apiKey === undefined || apiKey.length === 0
        ? {}
        : { Authorization: `Bearer ${apiKey}` };
    const timeout = parseRequiredInt(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "PLURNK_PROVIDERS_FETCH_TIMEOUT", provider);
    const attempts = parseRequiredInt(env.PLURNK_PROVIDERS_PROBE_ATTEMPTS, "PLURNK_PROVIDERS_PROBE_ATTEMPTS", provider);
    const probe = await probeModelsRetrying(
        url,
        headers,
        model,
        timeout,
        attempts,
        parseRequiredInt(env.PLURNK_PROVIDERS_PROBE_DELAY, "PLURNK_PROVIDERS_PROBE_DELAY", provider),
    );
    const contextWindow = effectiveContextWindow(contextWindowFromEnv(env, provider), probe.nCtx);
    const pinRaw = env.PLURNK_PROVIDERS_LLAMA_SERVER;
    if (pinRaw !== undefined && pinRaw !== "" && pinRaw !== "0" && pinRaw !== "1") {
        throw new Error(`${provider} provider: PLURNK_PROVIDERS_LLAMA_SERVER must be "1", "0", or unset`);
    }
    const pinned = pinRaw === undefined || pinRaw === "" ? null : pinRaw === "1";
    const llamaServer = provider === "openai" && (pinned ?? probe.llamaServer);
    if (probe.failed && pinned === null && provider === "openai") {
        emitWarningOnce(
            `${provider} provider: llama-server detection failed after ${attempts} attempts; pin PLURNK_PROVIDERS_LLAMA_SERVER=1 when this is a llama-server`,
            "PLURNK_PROBE_FAILED",
        );
    }
    if (contextWindow === null) {
        emitWarningOnce(
            `${provider} provider: context window underivable for "${model}"; set PLURNK_PROVIDERS_CONTEXT_WINDOW`,
            "PLURNK_CONTEXT_UNKNOWN",
        );
    }

    let grammarStyle: GrammarStyle = "none";
    let reasoningStyle: ReasoningStyle = provider === "openai" ? "think" : "none";
    let slotCount: number | null = null;
    let eosText: string | undefined;
    let tokenizeUrl: string | undefined;
    let promptTokensUrl: string | undefined;
    if (llamaServer) {
        grammarStyle = "llamacpp";
        reasoningStyle = "template";
        const props = await probeProps(url, headers, timeout);
        slotCount = props.slotCount;
        eosText = props.eosText ?? undefined;
        tokenizeUrl = url.replace(/\/v1\/chat\/completions$/, "/tokenize");
        promptTokensUrl = url.replace(/\/v1\/chat\/completions$/, "/v1/chat/completions/input_tokens");
    }

    if (!llamaServer) {
        emitWarningOnce(
            `${provider} provider: physical prompt counting is a chars/2 estimate; over-policy recovery fails closed without exact or bounded request evidence`,
            "PLURNK_PROMPT_COUNT_ESTIMATE",
        );
    }
    const { reasoningReserve, completionReserve } = envelopeFromEnv(env, provider);
    return new AiSdkProvider({
        model,
        url,
        headers,
        contextWindow,
        fetchTimeoutMs: timeout,
        streamIdleTimeoutMs: parseRequiredInt(env.PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT, "PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT", provider),
        reasoning: reasoningFromEnv(env, provider),
        reasoningResponseStyle: reasoningResponseStyleFromEnv(env, provider),
        reasoningStyle,
        temperature: parseRequiredFloat(env.PLURNK_PROVIDERS_TEMPERATURE, "PLURNK_PROVIDERS_TEMPERATURE", provider, 0),
        repeatPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_REPEAT_PENALTY, "PLURNK_PROVIDERS_REPEAT_PENALTY", provider, 0),
        frequencyPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_FREQUENCY_PENALTY, "PLURNK_PROVIDERS_FREQUENCY_PENALTY", provider, 0),
        dryMultiplier: parseOptionalFloat(env.PLURNK_PROVIDERS_DRY_MULTIPLIER, "PLURNK_PROVIDERS_DRY_MULTIPLIER", provider, 0) ?? undefined,
        dryBase: parseOptionalFloat(env.PLURNK_PROVIDERS_DRY_BASE, "PLURNK_PROVIDERS_DRY_BASE", provider, 0) ?? undefined,
        dryAllowedLength: parseOptionalInt(env.PLURNK_PROVIDERS_DRY_ALLOWED_LENGTH, "PLURNK_PROVIDERS_DRY_ALLOWED_LENGTH", provider) ?? undefined,
        repeatLastN: parseOptionalInt(env.PLURNK_PROVIDERS_REPEAT_LAST_N, "PLURNK_PROVIDERS_REPEAT_LAST_N", provider) ?? undefined,
        reasoningReserve,
        completionReserve,
        tuningFloors: provider !== "plurnk",
        retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", provider),
        errorDetailLimit: parseRequiredInt(env.PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT, "PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT", provider),
        promptCacheKey: promptCacheKeyFromEnv(env, provider),
        source: providerSource(provider),
        grammarStyle,
        gbnfDebug: env.PLURNK_PROVIDERS_GBNF_DEBUG !== undefined
            && env.PLURNK_PROVIDERS_GBNF_DEBUG !== ""
            && env.PLURNK_PROVIDERS_GBNF_DEBUG !== "0",
        ...dataCaptureFromEnv(env, provider),
        firstPartyMetadata: provider === "plurnk",
        apiKeyRejectedMessage: provider === "plurnk"
            ? "PLURNK_API_KEY was rejected by plurnk.ai (invalid or expired)."
            : undefined,
        supportsSlotPinning: llamaServer,
        slotCount,
        eosText,
        tokenizeUrl,
        promptTokensUrl,
        servedModel: probe.servedModel ?? undefined,
        requiresMaxTokens: llamaServer || undefined,
    });
};
