import type BaseHandler from "./BaseHandler.ts";
import type { HandlerLoader } from "./Mimetypes.ts";

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
    // Current vector representation ({§mimetype-embedding-wire}).
    embed(text: string): Promise<Uint8Array>;
    // Input-order bulk surface; absence selects the sequential adapter.
    embedBatch?(texts: readonly string[], options?: EmbedBatchOptions): Promise<Uint8Array[]>;
    readonly dimension: number;
    // Model-space identity surfaced on ProcessResult.embeddingModel.
    readonly model?: string;
    // Optional consumer chunk-planning facts.
    readonly contextWindow?: number;
    countTokens?(text: string): Promise<number>;
    dispose?(): Promise<void> | void;
}

// Presence and optional planning facts remain distinct
// ({§mimetype-embedding}).
export interface EmbedderInfo {
    dimension: number;
    // The input context window, or null = unknown.
    contextWindow: number | null;
    // The model's own counter, or null = no counter available.
    countTokens: ((text: string) => Promise<number>) | null;
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
        } catch {
            // Current behavior collapses unsupported projection and projection
            // defects to empty bytes; #92 owns the causal failure taxonomy.
            return { embedding: new Uint8Array(0) };
        }
        if (text === undefined || text.length === 0) return { embedding: new Uint8Array(0) };
        return {
            embedding: await embedder.embed(text),
            ...(typeof embedder.model === "string" && { embeddingModel: embedder.model }),
        };
    }

    #resolve(): Promise<Embedder | null> {
        this.#promise ??= (async () => {
            let mod: unknown;
            try {
                mod = await this.#loader(EMBEDDINGS_PACKAGE);
            } catch (err) {
                // Only module absence selects degradation; import defects surface.
                const code = (err as { code?: string })?.code;
                if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return null;
                throw err;
            }
            const m = mod as { embed?: unknown; dimension?: unknown; default?: { embed?: unknown; dimension?: unknown } };
            const surface = typeof m.embed === "function" ? m : m.default;
            if (typeof surface?.embed !== "function" || typeof surface?.dimension !== "number") {
                return null;
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
                ? (text) => countTokens.call(embedder, text)
                : null,
            ...(typeof model === "string" && { model }),
        };
    }

    // Bulk output preserves input order; an absent bulk capability is adapted
    // sequentially. Calling the explicit surface without an artifact throws.
    async batch(texts: readonly string[], options?: EmbedBatchOptions): Promise<Uint8Array[]> {
        const embedder = await this.#resolve();
        if (embedder === null) {
            throw new Error(
                `embedBatch() requested but ${EMBEDDINGS_PACKAGE} is not installed. `
                + `npm install ${EMBEDDINGS_PACKAGE} to enable it.`,
            );
        }
        if (typeof embedder.embedBatch === "function") {
            return embedder.embedBatch(texts, options);
        }
        // Sequential adapter preserves progress and cancellation semantics.
        const out: Uint8Array[] = [];
        for (let i = 0; i < texts.length; i += 1) {
            options?.signal?.throwIfAborted();
            out.push(await embedder.embed(texts[i]));
            options?.onProgress?.({ completed: i + 1, total: texts.length });
        }
        return out;
    }

    // Idempotent cache teardown; later use resolves lazily again.
    async dispose(): Promise<void> {
        if (this.#promise === null) return;
        const pending = this.#promise;
        this.#promise = null;
        try {
            const embedder = await pending;
            if (embedder && typeof embedder.dispose === "function") await embedder.dispose();
        } catch {
            // #89 records the unresolved aggregate-disposal failure policy.
        }
    }
}
