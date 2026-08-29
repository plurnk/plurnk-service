import type BaseHandler from "./BaseHandler.ts";
import type { HandlerLoader } from "./Mimetypes.ts";
import type { TokenCountOptions } from "./Tokenizers.ts";
import {
    Validator,
    type ProviderRequestAccounting,
    type ProviderRequestObserver,
} from "@plurnk/plurnk-contracts";
import { isExactModuleAbsent } from "./module-absence.ts";
import EmbeddingVector from "./EmbeddingVector.ts";
import { UnsupportedDialectError } from "./QueryError.ts";

// Fixed embedding artifact seam, resolved lazily ({§mimetype-embedding}).
const EMBEDDINGS_PACKAGE = "@plurnk/plurnk-mimetypes-embeddings";

export interface EmbedProgress {
    completed: number;
    total: number;
}
export interface EmbeddingCallMetadata {
    readonly inputTokens: number | null;
    readonly warnings: readonly unknown[];
    readonly accounting: readonly ProviderRequestAccounting[];
    readonly providerMetadata?: Readonly<Record<string, unknown>>;
    // One bounded header record per provider request when supplied by the adapter.
    readonly responses?: readonly {
        readonly headers?: Readonly<Record<string, string>>;
    }[];
}
export interface EmbedDocumentsOptions {
    // Reports monotonically completed inputs after a local result or hosted partition.
    onProgress?(progress: EmbedProgress): void;
    // Cancels in-flight work; rejects the batch.
    signal?: AbortSignal;
    observeRequest?: ProviderRequestObserver;
}
export interface EmbedQueryOptions {
    signal?: AbortSignal;
    observeRequest?: ProviderRequestObserver;
}
export interface EmbedQueryResult {
    readonly vector: Uint8Array;
    readonly metadata: EmbeddingCallMetadata;
}
export interface EmbedDocumentsResult {
    readonly vectors: readonly Uint8Array[];
    readonly metadata: EmbeddingCallMetadata;
}

// Internal artifact boundary; optional members represent declared capability.
interface Embedder {
    // Canonical vector representation ({§mimetype-embedding-wire}).
    embedQuery(text: string, options?: EmbedQueryOptions): Promise<EmbedQueryResult>;
    // Input-order bulk surface.
    embedDocuments(texts: readonly string[], options?: EmbedDocumentsOptions): Promise<EmbedDocumentsResult>;
    readonly dimension: number;
    // Model-space identity surfaced on ProcessResult.embeddingModel.
    readonly model: string;
    // Optional consumer chunk-planning facts.
    readonly contextWindow?: number;
    readonly tokenizerModel?: string;
    countTokens?(text: string, options?: TokenCountOptions): Promise<number>;
    dispose?(): Promise<void> | void;
}

// Presence and optional planning facts remain distinct
// ({§mimetype-embedding}).
export interface EmbedderInfo {
    dimension: number;
    // The input context window, or null = unknown.
    contextWindow: number | null;
    // The model's own counter, or null = no counter available.
    countTokens: ((text: string, options?: TokenCountOptions) => Promise<number>) | null;
    // Exact tokenizer selector for a hosted profile, or null when not declared.
    tokenizerModel: string | null;
    // Model-space identity is required for durable inference evidence.
    model: string;
}

// Owns lazy artifact resolution and lifecycle ({§mimetype-embedding}).
export default class Embeddings {
    readonly #loader: HandlerLoader;
    // Cache one resolution per orchestrator lifetime.
    #promise: Promise<Embedder | null> | null = null;

    constructor(loader: HandlerLoader) {
        this.#loader = loader;
    }

    // Embed the handler's one readable projection ({§mimetype-content}).
    async embedFor(
        content: string | Uint8Array,
        handler: BaseHandler | null,
        strict: boolean,
    ): Promise<{ embedding: Uint8Array; embeddingMetadata?: EmbeddingCallMetadata; embeddingMissing?: string }> {
        const embedder = await this.#resolve();
        if (embedder === null) {
            if (strict) {
                throw new Error(
                    `Embedding channel requested but ${EMBEDDINGS_PACKAGE} is not `
                    + `installed. npm install ${EMBEDDINGS_PACKAGE} to enable it.`,
                );
            }
            return { embedding: new Uint8Array(0), embeddingMissing: EMBEDDINGS_PACKAGE };
        }
        let text: string | undefined;
        try {
            if (handler !== null) {
                // content() is the model-readable projection (HTML markdown);
                // undefined for handlers whose body is already readable, where
                // toText supplies the passthrough/page-text body.
                const readable = await handler.content(content);
                text = typeof readable === "string"
                    ? readable
                    : await (handler as unknown as { toText(c: string | Uint8Array): string | Promise<string> }).toText(content);
            } else if (typeof content === "string") {
                text = content;
            }
        } catch (cause) {
            if (isUnsupportedReadableProjection(cause)) {
                return { embedding: new Uint8Array(0) };
            }
            throw cause;
        }
        if (text === undefined || text.length === 0) return { embedding: new Uint8Array(0) };
        const result: unknown = await embedder.embedQuery(text);
        const query = result as Partial<EmbedQueryResult>;
        EmbeddingVector.assert(query.vector, embedder.dimension, `${EMBEDDINGS_PACKAGE}.embedQuery()`);
        assertMetadata(query.metadata, `${EMBEDDINGS_PACKAGE}.embedQuery()`);
        return {
            embedding: query.vector!,
            embeddingMetadata: query.metadata!,
            ...(typeof embedder.model === "string" && { embeddingModel: embedder.model }),
        };
    }

    #resolve(): Promise<Embedder | null> {
        this.#promise ??= (async () => {
            let mod: unknown;
            try {
                mod = await this.#loader(EMBEDDINGS_PACKAGE);
            } catch (err) {
                if (isExactModuleAbsent(err, EMBEDDINGS_PACKAGE)) return null;
                throw err;
            }
            const m = mod as {
                embedQuery?: unknown;
                embedDocuments?: unknown;
                dimension?: unknown;
                model?: unknown;
                default?: { embedQuery?: unknown; embedDocuments?: unknown; dimension?: unknown; model?: unknown };
            };
            const surface = typeof m.embedQuery === "function" ? m : m.default;
            if (typeof surface?.embedQuery !== "function") {
                throw new TypeError(`${EMBEDDINGS_PACKAGE} does not implement embedQuery()`);
            }
            if (typeof surface.embedDocuments !== "function") {
                throw new TypeError(`${EMBEDDINGS_PACKAGE} does not implement embedDocuments()`);
            }
            if (!Number.isSafeInteger(surface.dimension) || (surface.dimension as number) < 1) {
                throw new TypeError(`${EMBEDDINGS_PACKAGE} does not declare a positive safe-integer dimension`);
            }
            if (typeof surface.model !== "string" || surface.model.length === 0) {
                throw new TypeError(`${EMBEDDINGS_PACKAGE} does not declare a non-empty model identity`);
            }
            return surface as unknown as Embedder;
        })();
        return this.#promise;
    }

    // null means no artifact; null fields mean unknown optional facts.
    async info(): Promise<EmbedderInfo | null> {
        const embedder = await this.#resolve();
        if (!embedder) return null;
        const { dimension, contextWindow, countTokens, model, tokenizerModel } = embedder;
        return {
            dimension,
            contextWindow: typeof contextWindow === "number" ? contextWindow : null,
            countTokens: typeof countTokens === "function"
                ? (text, options) => countTokens.call(embedder, text, options)
                : null,
            tokenizerModel: typeof tokenizerModel === "string" ? tokenizerModel : null,
            model,
        };
    }

    // Explicit query-role embedding through the same artifact seam.
    async query(text: string, options?: EmbedQueryOptions): Promise<EmbedQueryResult> {
        const embedder = await this.#resolve();
        if (embedder === null) {
            throw new Error(
                `embedQuery() requested but ${EMBEDDINGS_PACKAGE} is not installed. `
                + `npm install ${EMBEDDINGS_PACKAGE} to enable it.`,
            );
        }
        const result: unknown = await embedder.embedQuery(text, options);
        const query = result as Partial<EmbedQueryResult>;
        EmbeddingVector.assert(query.vector, embedder.dimension, `${EMBEDDINGS_PACKAGE}.embedQuery()`);
        assertMetadata(query.metadata, `${EMBEDDINGS_PACKAGE}.embedQuery()`);
        return { vector: query.vector!, metadata: query.metadata! };
    }

    // Bulk output preserves input order. Calling the explicit surface without
    // an artifact throws.
    async documents(texts: readonly string[], options?: EmbedDocumentsOptions): Promise<EmbedDocumentsResult> {
        const embedder = await this.#resolve();
        if (embedder === null) {
            throw new Error(
                `embedDocuments() requested but ${EMBEDDINGS_PACKAGE} is not installed. `
                + `npm install ${EMBEDDINGS_PACKAGE} to enable it.`,
            );
        }
        const result: unknown = await embedder.embedDocuments(texts, options);
        const documents = result as Partial<EmbedDocumentsResult>;
        const vectors: unknown = documents.vectors;
        if (!Array.isArray(vectors)) {
            throw new TypeError(`${EMBEDDINGS_PACKAGE}.embedDocuments() must return an array of vectors`);
        }
        if (vectors.length !== texts.length) {
            throw new RangeError(
                `${EMBEDDINGS_PACKAGE}.embedDocuments() received ${texts.length} inputs but returned ${vectors.length} vectors`,
            );
        }
        for (const [index, vector] of vectors.entries()) {
            EmbeddingVector.assert(
                vector,
                embedder.dimension,
                `${EMBEDDINGS_PACKAGE}.embedDocuments() vector ${index}`,
            );
        }
        assertMetadata(documents.metadata, `${EMBEDDINGS_PACKAGE}.embedDocuments()`);
        return { vectors, metadata: documents.metadata! };
    }

    // Idempotent cache teardown; later use resolves lazily again.
    async dispose(): Promise<void> {
        if (this.#promise === null) return;
        const pending = this.#promise;
        this.#promise = null;
        const embedder = await pending;
        if (embedder && typeof embedder.dispose === "function") await embedder.dispose();
    }
}

function assertMetadata(value: unknown, source: string): asserts value is EmbeddingCallMetadata {
    if (typeof value !== "object" || value === null) {
        throw new TypeError(`${source} must return embedding call metadata`);
    }
    const metadata = value as Partial<EmbeddingCallMetadata>;
    if (metadata.inputTokens !== null
        && (!Number.isSafeInteger(metadata.inputTokens) || (metadata.inputTokens as number) < 0)) {
        throw new TypeError(`${source} metadata.inputTokens must be a non-negative safe integer or null`);
    }
    if (!Array.isArray(metadata.warnings)) {
        throw new TypeError(`${source} metadata.warnings must be an array`);
    }
    if (!Array.isArray(metadata.accounting)) {
        throw new TypeError(`${source} metadata.accounting must be an array`);
    }
    for (const [index, request] of metadata.accounting.entries()) {
        const result = Validator.validateProviderRequestAccounting(request);
        if (!result.valid) {
            throw new TypeError(
                `${source} metadata.accounting[${index}] is invalid: ${JSON.stringify(result.errors)}`,
            );
        }
    }
    if (metadata.providerMetadata !== undefined
        && (typeof metadata.providerMetadata !== "object"
            || metadata.providerMetadata === null
            || Array.isArray(metadata.providerMetadata))) {
        throw new TypeError(`${source} metadata.providerMetadata must be an object`);
    }
    if (metadata.responses !== undefined && (!Array.isArray(metadata.responses)
        || metadata.responses.some((response) => typeof response !== "object"
            || response === null
            || (response.headers !== undefined
                && (typeof response.headers !== "object"
                    || response.headers === null
                    || Array.isArray(response.headers)
                    || Object.values(response.headers).some((header) => typeof header !== "string")))))) {
        throw new TypeError(`${source} metadata.responses must be an array of response metadata`);
    }
}

function isUnsupportedReadableProjection(error: unknown): boolean {
    return error instanceof UnsupportedDialectError
        || (typeof error === "object"
            && error !== null
            && (error as { name?: unknown }).name === "UnsupportedDialectError");
}
