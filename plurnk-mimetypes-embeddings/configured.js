import {
    createEmbeddingModel,
    parseAliasesFromEnv,
    parseRequiredInt,
    resolveModelSelector,
    scopeEnvToAlias,
} from "@plurnk/plurnk-providers";
import { resolveEmbeddingProfile } from "./profiles.js";
import { countProfileTokens, disposeProfileTokenizers } from "./profile-tokenizers.js";
import { embedDocumentsWithModel, embedQueryWithModel } from "./standard.js";

const EMBEDDING_KNOBS = [
    "PLURNK_EMBEDDING_CONCURRENCY",
    "PLURNK_EMBEDDING_DIMENSIONS",
    "PLURNK_EMBEDDING_CONTEXT_WINDOW",
    "PLURNK_EMBEDDING_TOKENIZER",
    "PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST",
];

const positiveConcurrency = (env, label) => {
    const value = parseRequiredInt(
        env.PLURNK_EMBEDDING_CONCURRENCY,
        "PLURNK_EMBEDDING_CONCURRENCY",
        label,
    );
    if (value < 1) throw new RangeError(`${label}: PLURNK_EMBEDDING_CONCURRENCY must be a positive integer`);
    return value;
};

export const resolveConfiguredEmbedder = (env = process.env) => {
    const selector = env.PLURNK_EMBEDDING_MODEL?.trim();
    if (selector === undefined || selector === "") return null;
    const route = resolveModelSelector(selector, parseAliasesFromEnv(env));
    if (route === null) {
        throw new Error(
            `PLURNK_EMBEDDING_MODEL '${selector}' is neither a declared alias nor a provider/model route`,
        );
    }
    const providerEnv = "alias" in route
        ? scopeEnvToAlias(env, route.alias)
        : env;
    const scopedEnv = "alias" in route
        ? scopeEnvToAlias(providerEnv, route.alias, EMBEDDING_KNOBS)
        : providerEnv;
    const resolution = createEmbeddingModel(route.provider, route.model, scopedEnv, route.baseUrl);
    if (resolution === null) throw new Error(`Unknown embedding provider '${route.provider}'`);
    const profile = resolveEmbeddingProfile({
        provider: resolution.providerId,
        model: resolution.modelId,
    }, scopedEnv);
    const label = `${resolution.providerId}/${resolution.modelId} embedding`;
    const maxRetries = parseRequiredInt(
        scopedEnv.PLURNK_PROVIDERS_RETRY_ATTEMPTS,
        "PLURNK_PROVIDERS_RETRY_ATTEMPTS",
        label,
    );
    const maxParallelCalls = positiveConcurrency(scopedEnv, label);

    return {
        dimension: profile.dimensions,
        contextWindow: profile.contextWindow,
        tokenizerModel: profile.tokenizerModel,
        model: profile.modelIdentity,
        countTokens: profile.tokenizerFamily === undefined
            ? undefined
            : (text, options) => countProfileTokens(profile.tokenizerFamily, text, options),
        async embedQuery(text, { observeRequest, signal } = {}) {
            return embedQueryWithModel({
                model: resolution.embeddingModel,
                identity: { provider: resolution.providerId, model: resolution.modelId },
                text,
                transform: profile.query,
                dimension: profile.dimensions,
                label,
                maxRetries,
                normalizeAccounting: resolution.normalizeAccounting,
                observeRequest,
                signal,
            });
        },
        async embedDocuments(texts, { observeRequest, onProgress, signal } = {}) {
            if (!Array.isArray(texts)) throw new TypeError("embedDocuments: texts must be an array");
            return embedDocumentsWithModel({
                model: resolution.embeddingModel,
                identity: { provider: resolution.providerId, model: resolution.modelId },
                texts,
                transform: profile.document,
                dimension: profile.dimensions,
                label,
                maxRetries,
                maxEmbeddingsPerCall: profile.maxEmbeddingsPerCall,
                maxParallelCalls,
                normalizeAccounting: resolution.normalizeAccounting,
                observeRequest,
                onProgress,
                signal,
            });
        },
        async dispose() {
            disposeProfileTokenizers();
        },
    };
};
