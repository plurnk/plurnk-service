import type BaseHandler from "./BaseHandler.ts";
import type { HandlerLoader } from "./Mimetypes.ts";

// The embedder package (issue #24). Opt-in artifact dependency, resolved
// lazily through the same loader handler packages use — per-grammar-package
// precedent: the framework ships no model weights.
const EMBEDDINGS_PACKAGE = "@plurnk/plurnk-mimetypes-embeddings";

// Progress + cancellation for bulk embedding (plurnk-service#272).
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

// Surface the embeddings package must export.
interface Embedder {
    // text → native-endian raw Float32 bytes (4 × dimension).
    embed(text: string): Promise<Uint8Array>;
    // Bulk embedding (embeddings 0.5.0): same bytes as embed() per text,
    // data-parallel across a worker pool, returned in INPUT order. Optional —
    // an embedder predating it omits it and Mimetypes.embedBatch() falls back
    // to a sequential embed() loop (still honoring onProgress/signal).
    embedBatch?(texts: readonly string[], options?: EmbedBatchOptions): Promise<Uint8Array[]>;
    readonly dimension: number;
    // Model identity (e.g. "Xenova/all-MiniLM-L6-v2@751bff37+q8"). Surfaced on
    // ProcessResult.embeddingModel so consumers can store it alongside
    // vectors and detect incomparable BLOBs after a model swap.
    readonly model?: string;
    // Pure model facts for the host's lossless chunker (embeddings#1).
    // Optional — an embedder predating the chunking surface omits them and
    // embedderInfo() reports null, so the host stays on whole-entry behavior.
    readonly maxTokens?: number;
    countTokens?(text: string): Promise<number>;
    // Release the embedder's native runtime (onnxruntime worker pool). Optional;
    // an embedder without it just can't be torn down. Surfaced via
    // Mimetypes.dispose() (issue #36).
    dispose?(): Promise<void> | void;
}

// What embedderInfo() hands the host: the token window plus the model's own
// counter, the two facts its chunker needs to tile losslessly. null when no
// embedder is installed OR the installed one predates this surface.
export interface EmbedderInfo {
    maxTokens: number;
    countTokens(text: string): Promise<number>;
    // The embedder's model identity (#31) — the same string surfaced on
    // ProcessResult.embeddingModel. The host folds it into each entry's
    // deep_hash so a model-id change (a re-quantization like +q8, or a swap
    // keeping the same window) re-derives existing embeddings instead of
    // silently excluding them from ~query. Omitted if the embedder predates
    // exporting it (host treats absence as "no re-derivation signal").
    model?: string;
}

// The framework's single embedder seam (issues #24/#31/#36). Owns the opt-in
// @plurnk/plurnk-mimetypes-embeddings package's lifecycle — lazy resolution,
// the per-entry/bulk embed surfaces, chunking facts, and native teardown — so
// Mimetypes stays a pure orchestrator and the host never reaches the package
// directly.
export default class Embeddings {
    readonly #loader: HandlerLoader;
    // Primed-promise cache for the opt-in embedder (issue #24). null result
    // = package not installed/loadable; the promise itself is cached so the
    // model loads once per orchestrator lifetime.
    #promise: Promise<Embedder | null> | null = null;

    constructor(loader: HandlerLoader) {
        this.#loader = loader;
    }

    // Embedding channel (issue #24). Embeds the entry's READABLE projection,
    // not its raw bytes — the content channel where present (HTML → markdown),
    // else toText (binary → page text; text → passthrough body). So HTML
    // embeddings carry the article, not `<div class>` noise. Empty bytes when
    // no projection exists; missing embedder package degrades with an install
    // hint (#14 precedent) or throws under strict.
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
            // No text projection (binary without toText override) — nothing to
            // embed; empty bytes are the honest channel.
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
            } catch {
                return null;
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

    // Pure model facts for plurnk-service's lossless chunker (embeddings#1):
    // the token window and the model's own tokenizer counter. The host calls
    // this once per derivation — null → one whole-entry chunk (today's
    // behavior); non-null → tile the body into <= maxTokens chunks measured by
    // countTokens. null when no embedder is installed OR the installed
    // embedder predates this surface (no maxTokens/countTokens).
    async info(): Promise<EmbedderInfo | null> {
        const embedder = await this.#resolve();
        if (!embedder || typeof embedder.maxTokens !== "number" || typeof embedder.countTokens !== "function") {
            return null;
        }
        const { maxTokens, countTokens, model } = embedder;
        return {
            maxTokens,
            countTokens: (text) => countTokens.call(embedder, text),
            ...(typeof model === "string" && { model }),
        };
    }

    // Bulk embedding entry for the host's corpus ingest (plurnk-service#272).
    // Returns one vector per input text, in INPUT order — bit-identical to
    // calling the embedding channel per text, so nothing already stored needs
    // re-embedding. Delegates to the embedder's data-parallel embedBatch() when
    // present (embeddings 0.5.0+, ~6x at 8 workers); falls back to a sequential
    // embed() loop for older embedders, still firing onProgress and honoring
    // signal. Single embedder seam: resolution + model identity stay framework-
    // owned (pair with info() for chunk budgeting), so the host never reaches
    // into the embeddings package directly.
    //
    // Unlike the per-entry channel (which degrades to empty bytes when the
    // package is absent), this is an explicit bulk call — a missing embedder is
    // a misconfiguration, so it throws rather than silently storing empties.
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
        // Fallback: embedder predates embedBatch. Sequential, but the host's
        // progress and cancellation contract is honored regardless.
        const out: Uint8Array[] = [];
        for (let i = 0; i < texts.length; i += 1) {
            options?.signal?.throwIfAborted();
            out.push(await embedder.embed(texts[i]));
            options?.onProgress?.({ completed: i + 1, total: texts.length });
        }
        return out;
    }

    // Release the embedder's native runtime so a consumer can drain its event
    // loop and exit (issue #36). The onnxruntime worker pool holds
    // active+referenced libuv handles that otherwise keep the process alive
    // after all work finishes. Awaits the embedder's own dispose() if one was
    // loaded, then drops the cached embedder. Idempotent — re-lazy-inits if used
    // again.
    async dispose(): Promise<void> {
        if (this.#promise === null) return;
        const pending = this.#promise;
        this.#promise = null;
        try {
            const embedder = await pending;
            if (embedder && typeof embedder.dispose === "function") await embedder.dispose();
        } catch {
            // embedder never loaded (package absent / load failed) — nothing to release.
        }
    }
}
