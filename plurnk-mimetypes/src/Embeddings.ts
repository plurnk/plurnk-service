import type BaseHandler from "./BaseHandler.ts";
import type { HandlerLoader } from "./Mimetypes.ts";
import type { TokenCountOptions } from "./Tokenizers.ts";
import { isExactModuleAbsent } from "./module-absence.ts";
import EmbeddingVector from "./EmbeddingVector.ts";
import { UnsupportedDialectError } from "./QueryError.ts";

// Fixed embedding artifact seam, resolved lazily ({§mimetype-embedding}).
const EMBEDDINGS_PACKAGE = "@plurnk/plurnk-mimetypes-embeddings";

export interface EmbedProgress {
    completed: number;
    total: number;
}
export interface EmbedBatchOptions {
    // Fires as each text finishes (out of input order — completion order).
    onProgress?(progress: EmbedProgress): void;
    // Cancels in-flight work; rejects the batch.
    signal?: AbortSignal;
}

// Internal artifact boundary; optional members represent declared capability.
interface Embedder {
    // Canonical vector representation ({§mimetype-embedding-wire}).
    embed(text: string): Promise<Uint8Array>;
    // Input-order bulk surface.
    embedBatch(texts: readonly string[], options?: EmbedBatchOptions): Promise<Uint8Array[]>;
    readonly dimension: number;
    // Model-space identity surfaced on ProcessResult.embeddingModel.
    readonly model?: string;
    // Optional consumer chunk-planning facts.
    readonly contextWindow?: number;
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
    // Model-space identity; omitted when the artifact does not declare one.
    model?: string;
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
    ): Promise<{ embedding: Uint8Array; embeddingMissing?: string }> {
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
        const embedding: unknown = await embedder.embed(text);
        EmbeddingVector.assert(embedding, embedder.dimension, `${EMBEDDINGS_PACKAGE}.embed()`);
        return {
            embedding,
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
                embed?: unknown;
                embedBatch?: unknown;
                dimension?: unknown;
                default?: { embed?: unknown; embedBatch?: unknown; dimension?: unknown };
            };
            const surface = typeof m.embed === "function" ? m : m.default;
            if (typeof surface?.embed !== "function") {
                throw new TypeError(`${EMBEDDINGS_PACKAGE} does not implement embed()`);
            }
            if (typeof surface.embedBatch !== "function") {
                throw new TypeError(`${EMBEDDINGS_PACKAGE} does not implement embedBatch()`);
            }
            if (!Number.isSafeInteger(surface.dimension) || (surface.dimension as number) < 1) {
                throw new TypeError(`${EMBEDDINGS_PACKAGE} does not declare a positive safe-integer dimension`);
            }
            return surface as unknown as Embedder;
        })();
        return this.#promise;
    }

    // null means no artifact; null fields mean unknown optional facts.
    async info(): Promise<EmbedderInfo | null> {
        const embedder = await this.#resolve();
        if (!embedder) return null;
        const { dimension, contextWindow, countTokens, model } = embedder;
        return {
            dimension,
            contextWindow: typeof contextWindow === "number" ? contextWindow : null,
            countTokens: typeof countTokens === "function"
                ? (text, options) => countTokens.call(embedder, text, options)
                : null,
            ...(typeof model === "string" && { model }),
        };
    }

    // Bulk output preserves input order. Calling the explicit surface without
    // an artifact throws.
    async batch(texts: readonly string[], options?: EmbedBatchOptions): Promise<Uint8Array[]> {
        const embedder = await this.#resolve();
        if (embedder === null) {
            throw new Error(
                `embedBatch() requested but ${EMBEDDINGS_PACKAGE} is not installed. `
                + `npm install ${EMBEDDINGS_PACKAGE} to enable it.`,
            );
        }
        const vectors: unknown = await embedder.embedBatch(texts, options);
        if (!Array.isArray(vectors)) {
            throw new TypeError(`${EMBEDDINGS_PACKAGE}.embedBatch() must return an array of vectors`);
        }
        if (vectors.length !== texts.length) {
            throw new RangeError(
                `${EMBEDDINGS_PACKAGE}.embedBatch() received ${texts.length} inputs but returned ${vectors.length} vectors`,
            );
        }
        for (const [index, vector] of vectors.entries()) {
            EmbeddingVector.assert(
                vector,
                embedder.dimension,
                `${EMBEDDINGS_PACKAGE}.embedBatch() vector ${index}`,
            );
        }
        return vectors;
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

function isUnsupportedReadableProjection(error: unknown): boolean {
    return error instanceof UnsupportedDialectError
        || (typeof error === "object"
            && error !== null
            && (error as { name?: unknown }).name === "UnsupportedDialectError");
}
