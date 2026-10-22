import { EFFORTS, isRecord, type Effort } from "@plurnk/plurnk-contracts";
import AiSdkProvider, { type GrammarStyle, type ReasoningStyle } from "./AiSdkProvider.ts";
import {
    contextWindowFromEnv,
    effectiveContextWindow,
    dataCaptureFromEnv,
    generationEnvelopeFromEnv,
    parseOptionalFloat,
    parseOptionalInt,
    samplingFromEnv,
    parseRequiredInt,
    parseTimeoutMs,
    cacheAffinityFromEnv,
    cacheWritePolicyFromEnv,
    effortFromEnv,
    reasoningResponseStyleFromEnv,
    inferenceAdmissionFromEnv,
} from "./env.ts";
import { providerSource } from "./notices.ts";
import RequestFields from "./RequestFields.ts";
import { UnsupportedEffortError, type Provider } from "./types.ts";
import { emitWarningOnce } from "./warnings.ts";

type EndpointProbe = {
    nCtx: number | null;
    llamaServer: boolean;
    servedModel: string | null;
    failed: boolean;
};

const provider = "openai";

// {§llama-template-effort} The server enforces off and adaptive itself; a fixed effort is the
// operator's declaration of a level the served chat template distinguishes.
const templateEfforts = (env: NodeJS.ProcessEnv): readonly Effort[] => {
    const declared: ReadonlySet<string> = new Set(RequestFields.declaredEfforts(provider, env));
    return EFFORTS.filter((policy) => policy === "off" || policy === "adaptive" || declared.has(policy));
};

const chatUrl = (env: NodeJS.ProcessEnv, override?: string): string => {
    const configured = override ?? env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE;
    if (configured === undefined || configured.length === 0) {
        throw new Error(`${provider} provider: OPENAI_BASE_URL or OPENAI_API_BASE must be set`);
    }
    const base = configured.replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) return base;
    return `${base.replace(/\/v1$/, "")}/v1/chat/completions`;
};

const probeModels = async (
    url: string,
    headers: Record<string, string>,
    model: string,
    timeout: number,
): Promise<EndpointProbe> => {
    const modelsUrl = url.replace(/\/chat\/completions$/, "/models");
    try {
        const response = await fetch(modelsUrl, {
            headers,
            ...(timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
        });
        if (!response.ok) return { nCtx: null, llamaServer: false, servedModel: null, failed: true };
        const data: unknown = await response.json();
        const rows = isRecord(data) && Array.isArray(data.data) ? data.data.filter(isRecord) : [];
        const row = rows.find((candidate) => candidate.id === model) ?? rows.at(0);
        const meta = row?.meta;
        const nCtx = (isRecord(meta) ? meta.n_ctx : undefined) ?? row?.n_ctx;
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
            ...(timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
        });
        if (!response.ok) return { slotCount: null, eosText: null };
        const data: unknown = await response.json();
        const props: Readonly<Record<string, unknown>> = isRecord(data) ? data : {};
        return {
            slotCount: typeof props.total_slots === "number" && props.total_slots > 0 ? props.total_slots : null,
            eosText: typeof props.eos_token === "string" && props.eos_token.length > 0 ? props.eos_token : null,
        };
    } catch {
        return { slotCount: null, eosText: null };
    }
};

export const compatibleProviderFromEnv = async (
    env: NodeJS.ProcessEnv,
    model: string,
    baseUrlOverride?: string,
): Promise<Provider> => {
    // The knobs remain universal and fail hard when malformed, but this local compatible
    // route declares no vendor cache projection: llama-server already owns slot affinity.
    cacheAffinityFromEnv(env, provider);
    cacheWritePolicyFromEnv(env, provider);
    const url = chatUrl(env, baseUrlOverride);
    const apiKey = env.OPENAI_API_KEY;
    const headers: Record<string, string> = apiKey === undefined || apiKey.length === 0
        ? {}
        : { Authorization: `Bearer ${apiKey}` };
    const timeout = parseTimeoutMs(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "PLURNK_PROVIDERS_FETCH_TIMEOUT", provider);
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
    const llamaServer = pinned ?? probe.llamaServer;
    if (probe.failed && pinned === null) {
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
    let reasoningStyle: ReasoningStyle = "think";
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
            `${provider} provider: request-level prompt counting is a chars/2 estimate; capacity is deferred to the provider`,
            "PLURNK_PROMPT_COUNT_ESTIMATE",
        );
    }
    const envelope = generationEnvelopeFromEnv(env, provider, contextWindow, null);
    const effort = effortFromEnv(env, provider, envelope.reasoningBudget);
    const supportedEfforts: readonly Effort[] = reasoningStyle === "template" ? templateEfforts(env) : ["off", "adaptive"];
    if (!supportedEfforts.includes(effort.mode)) {
        throw new UnsupportedEffortError(providerSource(provider), effort.mode, supportedEfforts, reasoningStyle === "template"
            ? `Declare each effort the served chat template distinguishes: PLURNK_PROVIDERS_REASONING_EFFORTS=${effort.mode} (comma-separated; an alias suffix scopes it to one alias).`
            : "This route sends no fixed-effort control.");
    }
    return new AiSdkProvider({
        inferenceAdmission: inferenceAdmissionFromEnv(env, url.replace(/\/chat\/completions$/, "")),
        model,
        url,
        headers,
        contextWindow,
        maxInputTokens: null,
        maxOutputTokens: null,
        outputBudget: envelope.outputBudget,
        outputFloor: envelope.outputFloor,
        reasoningBudget: effort.budget,
        supportedEfforts,
        fetchTimeoutMs: timeout,
        operationTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_OPERATION_TIMEOUT, "PLURNK_PROVIDERS_OPERATION_TIMEOUT", provider),
        effort,
        reasoningResponseStyle: reasoningResponseStyleFromEnv(env, provider),
        reasoningStyle,
        ...samplingFromEnv(env, provider),
        repeatPenalty: parseOptionalFloat(env.PLURNK_PROVIDERS_REPEAT_PENALTY, "PLURNK_PROVIDERS_REPEAT_PENALTY", provider, 0),
        dryMultiplier: parseOptionalFloat(env.PLURNK_PROVIDERS_DRY_MULTIPLIER, "PLURNK_PROVIDERS_DRY_MULTIPLIER", provider, 0) ?? undefined,
        dryBase: parseOptionalFloat(env.PLURNK_PROVIDERS_DRY_BASE, "PLURNK_PROVIDERS_DRY_BASE", provider, 0) ?? undefined,
        dryAllowedLength: parseOptionalInt(env.PLURNK_PROVIDERS_DRY_ALLOWED_LENGTH, "PLURNK_PROVIDERS_DRY_ALLOWED_LENGTH", provider) ?? undefined,
        repeatLastN: parseOptionalInt(env.PLURNK_PROVIDERS_REPEAT_LAST_N, "PLURNK_PROVIDERS_REPEAT_LAST_N", provider) ?? undefined,
        retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", provider),
        errorDetailLimit: parseRequiredInt(env.PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT, "PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT", provider),
        source: providerSource(provider),
        grammarStyle,
        ...dataCaptureFromEnv(env, provider),
        supportsSlotPinning: llamaServer,
        slotCount,
        eosText,
        tokenizeUrl,
        promptTokensUrl,
        servedModel: probe.servedModel ?? undefined,
        requiresOutputBudget: llamaServer || undefined,
    });
};
