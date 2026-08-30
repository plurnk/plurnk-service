import { createHash } from "node:crypto";
import { profileTokenizerFacts } from "./profile-tokenizers.js";

const QWEN_RETRIEVAL_INSTRUCTION = "Given a web search query, retrieve relevant passages that answer the query";

const unchanged = (value) => value;
const qwenQuery = (value) => `Instruct: ${QWEN_RETRIEVAL_INSTRUCTION}\nQuery:${value}`;
const QWEN_06_TOKENIZER = profileTokenizerFacts("qwen3embed06");
const QWEN_8_TOKENIZER = profileTokenizerFacts("qwen3embed8");
const CL100K_TOKENIZER = profileTokenizerFacts("cl100k");
const MINILM_TOKENIZER = profileTokenizerFacts("minilm");

const QWEN_06 = {
    dimensions: 1024,
    maxEmbeddingsPerCall: 1,
    tokenizerModel: "Qwen/Qwen3-Embedding-0.6B",
    tokenizerFamily: QWEN_06_TOKENIZER.family,
    tokenizerId: QWEN_06_TOKENIZER.tokenizerId,
    query: qwenQuery,
    document: unchanged,
    pooling: "last-token",
    normalization: "l2",
};

const QWEN_8 = {
    dimensions: 4096,
    maxEmbeddingsPerCall: 1,
    tokenizerModel: "Qwen/Qwen3-Embedding-8B",
    tokenizerFamily: QWEN_8_TOKENIZER.family,
    tokenizerId: QWEN_8_TOKENIZER.tokenizerId,
    query: qwenQuery,
    document: unchanged,
    pooling: "last-token",
    normalization: "l2",
};

const ROUTE_PROFILES = new Map([
    ["cloudflare-workers-ai/@cf/qwen/qwen3-embedding-0.6b", {
        ...QWEN_06,
        contextWindow: 8192,
    }],
    ["fireworks-ai/accounts/fireworks/models/qwen3-embedding-0p6b", {
        ...QWEN_06,
        contextWindow: 32768,
    }],
    ["fireworks-ai/accounts/fireworks/models/qwen3-embedding-8b", {
        ...QWEN_8,
        contextWindow: 40960,
    }],
    ["openrouter/qwen/qwen3-embedding-8b", {
        ...QWEN_8,
        contextWindow: 32768,
    }],
    ["openai/text-embedding-3-small", {
        dimensions: 1536,
        contextWindow: 8191,
        // OpenAI accepts at most 300,000 aggregate tokens. Capping the
        // cardinality by the per-input window keeps every standard AI SDK
        // partition below that limit without a second batching mechanism.
        maxEmbeddingsPerCall: 36,
        tokenizerModel: "cl100k",
        tokenizerFamily: CL100K_TOKENIZER.family,
        tokenizerId: CL100K_TOKENIZER.tokenizerId,
        query: unchanged,
        document: unchanged,
        pooling: "provider",
        normalization: "provider",
    }],
]);

// The bundled runtime's model served over an OpenAI-compatible /v1/embeddings (a
// llama-server on the GGUF): 512 positions less [CLS]/[SEP], which the server adds; the
// server owns mean pooling and L2 normalization; one input per slot on a 32-slot server.
const MINILM = {
    dimensions: 384,
    contextWindow: 510,
    maxEmbeddingsPerCall: 32,
    tokenizerModel: "sentence-transformers/all-MiniLM-L6-v2",
    tokenizerFamily: MINILM_TOKENIZER.family,
    tokenizerId: MINILM_TOKENIZER.tokenizerId,
    query: unchanged,
    document: unchanged,
    pooling: "provider",
    normalization: "provider",
};

const MODEL_PROFILES = new Map([
    ["qwen/qwen3-embedding-0.6b", { ...QWEN_06, contextWindow: 32768 }],
    ["qwen/qwen3-embedding-8b", { ...QWEN_8, contextWindow: 32768 }],
    ["sentence-transformers/all-minilm-l6-v2", MINILM],
]);

const requirePositiveInteger = (env, name) => {
    const raw = env[name]?.trim();
    const value = Number(raw);
    if (raw === undefined || raw === "" || !Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer for an embedding route without a built-in profile`);
    }
    return value;
};

const requireTokenizerModel = (env) => {
    const value = env.PLURNK_EMBEDDING_TOKENIZER?.trim();
    if (value === undefined || value === "") {
        throw new Error(
            "PLURNK_EMBEDDING_TOKENIZER must name an exact bundled tokenizer for an embedding route without a built-in profile",
        );
    }
    return value;
};

const assertNoKnownProfileOverrides = (env, route) => {
    const names = [
        "PLURNK_EMBEDDING_DIMENSIONS",
        "PLURNK_EMBEDDING_CONTEXT_WINDOW",
        "PLURNK_EMBEDDING_TOKENIZER",
        "PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST",
    ];
    const set = names.filter((name) => (env[name] ?? "").trim() !== "");
    if (set.length > 0) {
        throw new Error(`${route} has a built-in embedding profile; remove duplicate operator facts: ${set.join(", ")}`);
    }
};

const profileIdentity = (provider, model, profile) => {
    const policy = profile.query === qwenQuery
        ? { query: `Instruct: ${QWEN_RETRIEVAL_INSTRUCTION}\\nQuery:<query>`, document: "identity" }
        : { query: "identity", document: "identity" };
    const facts = JSON.stringify({
        provider,
        model,
        dimensions: profile.dimensions,
        contextWindow: profile.contextWindow,
        tokenizerModel: profile.tokenizerModel,
        tokenizerId: profile.tokenizerId,
        pooling: profile.pooling,
        normalization: profile.normalization,
        policy,
    });
    return createHash("sha256").update(facts).digest("hex").slice(0, 16);
};

// Exact provider routes own hosted constraints; canonical upstream model refs
// provide the same profile for local standard endpoints. An arbitrary endpoint
// must declare its complete symmetric profile instead of borrowing facts by
// model-name resemblance.
export const resolveEmbeddingProfile = ({ provider, model }, env = process.env) => {
    const route = `${provider}/${model}`;
    const routeKey = route.toLowerCase();
    const modelKey = model.toLowerCase();
    const known = ROUTE_PROFILES.get(routeKey) ?? MODEL_PROFILES.get(modelKey);
    const profile = known === undefined
        ? {
            dimensions: requirePositiveInteger(env, "PLURNK_EMBEDDING_DIMENSIONS"),
            contextWindow: requirePositiveInteger(env, "PLURNK_EMBEDDING_CONTEXT_WINDOW"),
            tokenizerModel: requireTokenizerModel(env),
            maxEmbeddingsPerCall: requirePositiveInteger(env, "PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST"),
            query: unchanged,
            document: unchanged,
            pooling: "provider",
            normalization: "provider",
        }
        : known;
    if (known !== undefined) assertNoKnownProfileOverrides(env, route);
    const fingerprint = profileIdentity(provider, model, profile);
    return {
        ...profile,
        fingerprint,
        modelIdentity: `${route}@${fingerprint}`,
    };
};
