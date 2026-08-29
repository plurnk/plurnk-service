import { embed, embedMany } from "ai";
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";

const responseMetadata = (result) => {
    const values = Array.isArray(result.responses)
        ? result.responses
        : result.response === undefined ? undefined : [result.response];
    if (values === undefined) return undefined;
    return values.map((value) => value?.headers === undefined ? {} : { headers: value.headers });
};

const metadataFrom = (result, accounting) => {
    const responses = responseMetadata(result);
    return {
        inputTokens: Number.isSafeInteger(result.usage?.tokens) && result.usage.tokens >= 0
            ? result.usage.tokens
            : null,
        warnings: result.warnings ?? [],
        accounting,
        ...(result.providerMetadata === undefined ? {} : { providerMetadata: result.providerMetadata }),
        ...(responses === undefined ? {} : { responses }),
    };
};

const encode = (value, dimension, source) => EmbeddingVector.encode(value, dimension, source);

const errorStatus = (error) => {
    for (const value of [error?.status, error?.statusCode, error?.response?.status]) {
        if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
    }
    return undefined;
};

const normalizationFailure = (cause) => {
    const error = new Error("provider request accounting could not be normalized after physical I/O", { cause });
    error.name = "EmbeddingRequestAccountingError";
    return error;
};

const withObservation = ({
    model,
    identity,
    observeRequest,
    normalizeAccounting,
    onProgress,
    total,
    maxEmbeddingsPerCall,
}) => {
    let completed = 0;
    let issued = 0;
    const accounting = [];
    const pending = [];
    const doEmbed = (options) => {
        const index = issued++;
        const operation = (async () => {
            const settle = observeRequest === undefined || normalizeAccounting === undefined
                ? undefined
                : await observeRequest(identity);
            const settleAccounting = async (outcome, evidence) => {
                if (normalizeAccounting === undefined) return;
                let request;
                let failure;
                try {
                    request = normalizeAccounting({ outcome, ...evidence });
                } catch (cause) {
                    failure = normalizationFailure(cause);
                    request = {
                        ...identity,
                        outcome,
                        ...(evidence.status === undefined ? {} : { status: evidence.status }),
                        cost: {
                            kind: "unknown",
                            reason: "provider request accounting could not be normalized after physical I/O",
                        },
                    };
                }
                accounting[index] = request;
                await settle?.(request);
                if (failure !== undefined) throw failure;
            };
            let result;
            try {
                result = await model.doEmbed(options);
            } catch (error) {
                const status = errorStatus(error);
                await settleAccounting("error", status === undefined ? {} : { status });
                throw error;
            }
            await settleAccounting("response", { result });
            completed += options.values.length;
            onProgress?.({ completed, total });
            return result;
        })();
        pending.push(operation);
        return operation;
    };
    // Preserve provider extensions (including the AI SDK byte-limit symbol)
    // while interposing only the public doEmbed call.
    const observedModel = new Proxy(model, {
        get(target, property) {
            if (property === "doEmbed") return doEmbed;
            if (property === "maxEmbeddingsPerCall" && maxEmbeddingsPerCall !== undefined) {
                const declared = Reflect.get(target, property, target);
                if (declared === undefined || declared === null) return maxEmbeddingsPerCall;
                return Promise.resolve(declared).then((value) => Math.min(value, maxEmbeddingsPerCall));
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return { model: observedModel, accounting, pending };
};

const withAccountingFailure = async (observed, execute) => {
    try {
        return await execute();
    } catch (cause) {
        await Promise.allSettled(observed.pending);
        if (observed.accounting.every((request) => request === undefined)) throw cause;
        const error = new Error("embedding inference failed", { cause });
        error.name = "EmbeddingInferenceError";
        error.accounting = observed.accounting.filter(Boolean);
        throw error;
    }
};

export const embedQueryWithModel = async ({
    model,
    identity,
    text,
    transform,
    dimension,
    label,
    maxRetries,
    normalizeAccounting,
    observeRequest,
    signal,
}) => {
    const observed = withObservation({
        model,
        identity,
        observeRequest,
        normalizeAccounting,
        total: 1,
    });
    return withAccountingFailure(observed, async () => {
        const result = await embed({
            model: observed.model,
            value: transform(text),
            maxRetries,
            ...(signal === undefined ? {} : { abortSignal: signal }),
        });
        return {
            vector: encode(result.embedding, dimension, `${label} query`),
            metadata: metadataFrom(result, observed.accounting.filter(Boolean)),
        };
    });
};

export const embedDocumentsWithModel = async ({
    model,
    identity,
    texts,
    transform,
    dimension,
    label,
    maxRetries,
    maxEmbeddingsPerCall,
    maxParallelCalls,
    normalizeAccounting,
    observeRequest,
    onProgress,
    signal,
}) => {
    if (texts.length === 0) {
        return { vectors: [], metadata: { inputTokens: 0, warnings: [], accounting: [] } };
    }
    const observed = withObservation({
        model,
        identity,
        observeRequest,
        normalizeAccounting,
        onProgress,
        total: texts.length,
        maxEmbeddingsPerCall,
    });
    return withAccountingFailure(observed, async () => {
        const result = await embedMany({
            model: observed.model,
            values: texts.map(transform),
            maxRetries,
            maxParallelCalls,
            ...(signal === undefined ? {} : { abortSignal: signal }),
        });
        return {
            vectors: result.embeddings.map((value, index) => encode(
                value,
                dimension,
                `${label} document ${index}`,
            )),
            metadata: metadataFrom(result, observed.accounting.filter(Boolean)),
        };
    });
};
