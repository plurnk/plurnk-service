// {§model-catalog-build} {§model-catalog-projection}
// Projects a Models.dev provider map (`api.json` or `@opencode-ai/models/snapshot`)
// into the validated PLURNK model and provider catalogs.

import type { ModelCost, ModelEffort, ModelInfo, ModelReasoningOption, ProviderInfo } from "./index.ts";

const SUPPORTED_NPM = new Set([
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/anthropic",
    "@ai-sdk/cerebras",
    "@ai-sdk/deepinfra",
    "@ai-sdk/google",
    "@ai-sdk/groq",
    "@ai-sdk/mistral",
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "@ai-sdk/togetherai",
    "@ai-sdk/xai",
    "@openrouter/ai-sdk-provider",
]);

const REASONING_EFFORTS: ReadonlySet<ModelEffort> = new Set<ModelEffort>([
    null, "none", "minimal", "low", "medium", "high", "xhigh", "max", "default",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isModelEffort = (value: unknown): value is ModelEffort =>
    value === null || (typeof value === "string" && (REASONING_EFFORTS as ReadonlySet<unknown>).has(value));

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item): item is string => typeof item === "string");

const pruneReasoningOptions = (
    providerId: string,
    modelId: string,
    model: Record<string, unknown>,
): readonly ModelReasoningOption[] | undefined => {
    const options = model.reasoning_options;
    if (model.reasoning !== true) {
        if (options !== undefined) {
            throw new Error(`Models.dev non-reasoning model ${providerId}/${modelId} declares reasoning_options`);
        }
        return undefined;
    }
    if (!Array.isArray(options)) {
        throw new Error(`Models.dev reasoning model ${providerId}/${modelId} has no reasoning_options capability facts`);
    }
    return options.map((option): ModelReasoningOption => {
        if (!isRecord(option)) {
            throw new Error(`Models.dev model ${providerId}/${modelId} has an unknown reasoning option`);
        }
        if (option.type === "toggle") return { type: "toggle" };
        if (option.type === "effort") {
            const values = option.values;
            if (!Array.isArray(values) || !values.every(isModelEffort)) {
                throw new Error(`Models.dev model ${providerId}/${modelId} has invalid reasoning effort values`);
            }
            return { type: "effort", values };
        }
        if (option.type === "budget_tokens") {
            return {
                type: "budget_tokens",
                ...(typeof option.min === "number" ? { min: option.min } : {}),
                ...(typeof option.max === "number" ? { max: option.max } : {}),
            };
        }
        throw new Error(`Models.dev model ${providerId}/${modelId} has an unknown reasoning option`);
    });
};

const prune = (providerId: string, modelId: string, m: unknown): ModelInfo | null => {
    if (!isRecord(m)) return null;
    const limit = isRecord(m.limit) ? m.limit : undefined;
    const contextWindow = limit?.context;
    if (typeof contextWindow !== "number" || contextWindow <= 0) return null;
    if (typeof m.name !== "string" || m.name.length === 0) {
        throw new Error(`Models.dev model ${providerId}/${modelId} has no display name`);
    }
    if (typeof m.attachment !== "boolean") {
        throw new Error(`Models.dev model ${providerId}/${modelId} has no attachment capability fact`);
    }
    if (typeof m.reasoning !== "boolean") {
        throw new Error(`Models.dev model ${providerId}/${modelId} has no reasoning capability fact`);
    }
    if (typeof m.tool_call !== "boolean") {
        throw new Error(`Models.dev model ${providerId}/${modelId} has no tool_call capability fact`);
    }
    const modalities = isRecord(m.modalities) ? m.modalities : undefined;
    if (!isStringArray(modalities?.input) || !isStringArray(modalities?.output)) {
        throw new Error(`Models.dev model ${providerId}/${modelId} has no modalities fact`);
    }
    const maxInputTokens = typeof limit?.input === "number" && limit.input > 0 ? limit.input : undefined;
    const maxOutputTokens = typeof limit?.output === "number" && limit.output > 0 ? limit.output : undefined;
    const structuredOutput = typeof m.structured_output === "boolean" ? m.structured_output : undefined;
    const temperature = typeof m.temperature === "boolean" ? m.temperature : undefined;

    let cost: ModelCost | undefined;
    const c = isRecord(m.cost) ? m.cost : undefined;
    if (c !== undefined && typeof c.input === "number" && typeof c.output === "number") {
        cost = {
            inputPer1M: c.input,
            outputPer1M: c.output,
            ...(typeof c.reasoning === "number" ? { reasoningPer1M: c.reasoning } : {}),
            ...(typeof c.cache_read === "number" ? { cacheReadPer1M: c.cache_read } : {}),
            ...(typeof c.cache_write === "number" ? { cacheWritePer1M: c.cache_write } : {}),
        };
    }

    const base = {
        name: m.name,
        contextWindow,
        attachment: m.attachment,
        toolCall: m.tool_call,
        modalities: {
            input: modalities.input,
            output: modalities.output,
        },
        ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
        ...(temperature === undefined ? {} : { temperature }),
        ...(cost === undefined ? {} : { cost }),
    };

    if (m.reasoning) {
        const reasoningOptions = pruneReasoningOptions(providerId, modelId, m);
        return {
            ...base,
            reasoning: true,
            reasoningOptions: reasoningOptions ?? [],
        };
    }
    pruneReasoningOptions(providerId, modelId, m);
    return {
        ...base,
        reasoning: false,
    };
};

export const projectCatalog = (db: unknown): {
    readonly catalog: Record<string, Record<string, ModelInfo>>;
    readonly providers: Record<string, ProviderInfo>;
} => {
    if (!isRecord(db)) {
        throw new Error("Models.dev catalog source must be a JSON object");
    }
    const catalog: Record<string, Record<string, ModelInfo>> = {};
    const providers: Record<string, ProviderInfo> = {};
    for (const [id, entry] of Object.entries(db)) {
        if (!isRecord(entry) || typeof entry.npm !== "string" || !SUPPORTED_NPM.has(entry.npm)) continue;
        if (typeof entry.name !== "string" || entry.name.length === 0) {
            throw new Error(`Models.dev provider ${id} has no display name`);
        }
        const env = isStringArray(entry.env) ? entry.env : [];
        providers[id] = {
            id: typeof entry.id === "string" ? entry.id : id,
            name: entry.name,
            npm: entry.npm,
            env,
            ...(typeof entry.api === "string" ? { api: entry.api } : {}),
        };
        const out: Record<string, ModelInfo> = {};
        const models = isRecord(entry.models) ? entry.models : {};
        for (const [modelId, m] of Object.entries(models)) {
            const info = prune(id, modelId, m);
            if (info !== null) out[modelId] = info;
        }
        if (Object.keys(out).length > 0) catalog[id] = out;
    }
    return { catalog, providers };
};
