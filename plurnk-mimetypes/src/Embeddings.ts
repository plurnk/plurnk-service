import type BaseHandler from "./BaseHandler.ts";
import type { HandlerLoader } from "./Mimetypes.ts";

// Opt-in embedder artifact package (SPEC §17, #24): resolved lazily via the
// same loader handler packages use — the framework ships no model weights.
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

// The duck surface the embeddings package must export (SPEC §17). Optional
// members let an older embedder predate a capability — the seam degrades.
interface Embedder {
    // text → native-endian raw Float32 bytes (4 × dimension).
    embed(text: string): Promise<Uint8Array>;
    // Data-parallel bulk embed in INPUT order (embeddings 0.5.0+); absent on
    // older embedders, where batch() falls back to a sequential embed() loop.
    embedBatch?(texts: readonly string[], options?: EmbedBatchOptions): Promise<Uint8Array[]>;
    readonly dimension: number;
    // Model identity (e.g. "Xenova/all-MiniLM-L6-v2@751bff37+q8"); surfaced on
    // ProcessResult.embeddingModel (SPEC §17, #31).
    readonly model?: string;
    // Lossless-chunking facts for the host (SPEC §17, embeddings#1); absent on
    // an embedder predating the chunking surface → info() reports null.
    readonly maxTokens?: number;
    countTokens?(text: string): Promise<number>;
    // Release the native runtime (onnxruntime worker pool); absent → untearable.
    dispose?(): Promise<void> | void;
}

// What info() hands the host (SPEC §17, reshaped by #50): PRESENCE facts,
// with unknowns explicitly null. null-the-whole-info means exactly one thing —
// NO embedder resolves. A working embedder with an incomplete self-report (a
// remote endpoint with no local tokenizer, a legacy embedder predating the
// chunking surface) returns info with maxTokens/countTokens null: "present,
// window unknown" and "absent" are different facts and the contract never
// conflates them again.
export interface EmbedderInfo {
    dimension: number;
    // The token window, or null = unknown (host takes its null-window lane).
    maxTokens: number | null;
    // The model's own counter, or null = no counter available.
    countTokens: ((text: string) => Promise<number>) | null;
    // Model identity (SPEC §17, #31) — the host folds it into each entry's
    // deep_hash so a model-id change re-derives existing embeddings instead of
    // silently excluding them from ~query. Omitted if the embedder predates it.
    model?: string;
}

// The framework's single embedder seam (SPEC §17, #24/#31/#36): owns the opt-in
// embeddings package's lifecycle — lazy resolution, per-entry/bulk embed,
// chunking facts, native teardown — so Mimetypes stays a pure orchestrator and
// the host never reaches the package directly.
export default class Embeddings {
    readonly #loader: HandlerLoader;
    // Primed-promise cache (SPEC §17, #24): null result = package not loadable;
    // the promise is cached so the model loads once per orchestrator lifetime.
    #promise: Promise<Embedder | null> | null = null;

    constructor(loader: HandlerLoader) {
        this.#loader = loader;
    }

    // Embedding channel (SPEC §17/§18, #24). Embeds the entry's READABLE
    // projection, not its raw bytes — content() where present (HTML → markdown),
    // else toText (binary → page text; text → passthrough body). Empty bytes
    // when no projection exists; a missing embedder package degrades with an
    // install hint (SPEC §7, #14) or throws under strict.
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
            } catch (err) {
                // Package genuinely absent → null → host degrades to FTS-only.
                // Any OTHER load error means the embedder IS installed but threw
                // on import (e.g. a required env knob unset) — that's a
                // misconfiguration, not "no embedder". Surface it, never silently
                // downgrade a broken embedder to "absent". "Absent" is the
                // resolver's own signal: import() of a missing specifier sets
                // code ERR_MODULE_NOT_FOUND (ESM) / MODULE_NOT_FOUND (CJS).
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

    // Embedder presence + chunking facts (SPEC §17; contract fixed by #50).
    // null ⇔ NO embedder resolves — never anything else. An embedder whose
    // self-report is incomplete returns info with the unknown facts explicitly
    // null; the host's presence gate stays truthful for remote/legacy embedders
    // instead of silently FTS-degrading a working endpoint.
    async info(): Promise<EmbedderInfo | null> {
        const embedder = await this.#resolve();
        if (!embedder) return null;
        const { dimension, maxTokens, countTokens, model } = embedder;
        return {
            dimension,
            maxTokens: typeof maxTokens === "number" ? maxTokens : null,
            countTokens: typeof countTokens === "function"
                ? (text) => countTokens.call(embedder, text)
                : null,
            ...(typeof model === "string" && { model }),
        };
    }

    // Bulk embedding for the host's corpus ingest (SPEC §17, plurnk-service#272).
    // One vector per input text, in INPUT order — bit-identical to the per-entry
    // channel, so nothing already stored re-embeds. Delegates to the embedder's
    // data-parallel embedBatch() when present (embeddings 0.5.0+); else a
    // sequential embed() loop, still firing onProgress and honoring signal.
    // Unlike the per-entry channel, a missing embedder throws here — an explicit
    // bulk call is a misconfiguration, not a silent-empties case.
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
    // loop and exit (SPEC §17, #36). The onnxruntime worker pool holds
    // active+referenced libuv handles that otherwise keep the process alive.
    // Awaits the embedder's own dispose() if loaded, then drops the cache.
    // Idempotent — re-lazy-inits if used again.
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
