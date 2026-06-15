// ~semantic (plurnk-service#186) — the FTS half. Re-indexes an entry's body
// content into entry_fts (the keyword/narrowing half of the fusion). The cosine
// rank over embedding vectors — the precise half — lands when the embedding
// channel does (a daughter projection, per the §mimetype boundary). Called from the
// gated manifest-add hook, so only when body content actually changed.

import type { Db, PrepMethod } from "../core/Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import EntryChunk from "./_entry-chunk.ts";

export default class EntrySemantic {
    // Replace an entry's FTS row with its current body content (rowid = entryId).
    // Empty content (binary member / cleared entry) → no FTS row (delete only).
    static async indexFts(db: Db, entryId: number, content: string): Promise<void> {
        await (db.fts_delete as PrepMethod).run({ entry_id: entryId });
        if (content.length > 0) await (db.fts_insert as PrepMethod).run({ entry_id: entryId, content });
    }

    // Cosine similarity over two Float32 vectors stored as BLOBs — the SqlRite
    // `cosine()` function delegates here (cosine.ts is the registration adapter).
    // Alignment-proof: the BLOB Uint8Array may be an unaligned view, so copy the
    // exact bytes to a fresh buffer before the Float32 view. A zero vector → 0.
    static cosine(a: Uint8Array, b: Uint8Array): number {
        const x = new Float32Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
        const y = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        let dot = 0, nx = 0, ny = 0;
        for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
        const denom = Math.sqrt(nx) * Math.sqrt(ny);
        return denom === 0 ? 0 : dot / denom;
    }

    // Store an entry's embedding vector + the model that produced it, or clear the
    // row (binary/empty entry, or a degraded `embeddingMissing` projection). Called
    // from the gated manifest-add hook beside indexFts / the symbol index.
    static async indexEmbedding(db: Db, entryId: number, chunks: { lineStart: number; lineEnd: number; vector: Uint8Array }[], model: string | undefined): Promise<void> {
        // Re-derivation = clear all of the entry's chunk rows, then insert each in seq
        // order. No model (no embedder installed) or no chunks → just cleared.
        await (db.embedding_delete as PrepMethod).run({ entry_id: entryId });
        if (model === undefined) return;
        for (const [seq, c] of chunks.entries()) {
            await (db.embedding_set as PrepMethod).run({
                entry_id: entryId, chunk_seq: seq, line_start: c.lineStart, line_end: c.lineEnd,
                vector: c.vector, embedding_model: model,
            });
        }
    }

    // Project Semantics — derive an entry's chunk embeddings. Probes the embedder
    // capability (the daughter's window + tokenizer, surfaced via the Mimetypes
    // handle): ABSENT → one whole-entry chunk from the fallback vector (today's
    // behavior, no extra embed call); PRESENT → lossless tile, embed each chunk.
    // Returns the chunk list + model for indexEmbedding; never touches the DB.
    static async deriveEmbeddings(
        mimetypes: Mimetypes,
        content: string,
        symbols: readonly { line?: number; endLine?: number }[],
        fallbackEmbedding: Uint8Array | undefined,
        fallbackModel: string | undefined,
    ): Promise<{ chunks: { lineStart: number; lineEnd: number; vector: Uint8Array }[]; model: string | undefined }> {
        const info = await EntrySemantic.#embedderInfo(mimetypes);
        if (info === null) {
            const totalLines = content.length === 0 ? 0 : content.split("\n").length;
            if (fallbackEmbedding === undefined || fallbackEmbedding.byteLength === 0 || totalLines === 0) return { chunks: [], model: undefined };
            return { chunks: [{ lineStart: 1, lineEnd: totalLines, vector: fallbackEmbedding }], model: fallbackModel };
        }
        // Symbol edges (a @graph endLine, or the line before a symbol starts) are the
        // tiler's preferred cut points; it still tiles every line if there are none.
        const boundaries = new Set<number>();
        for (const s of symbols) {
            if (typeof s.endLine === "number") boundaries.add(s.endLine);
            if (typeof s.line === "number" && s.line > 1) boundaries.add(s.line - 1);
        }
        const budget = EntrySemantic.#chunkBudget(info.maxTokens);
        const chunks: { lineStart: number; lineEnd: number; vector: Uint8Array }[] = [];
        let model: string | undefined;
        for (const spec of await EntryChunk.tile(content, boundaries, budget, EntrySemantic.#chunkOverlap(), info.countTokens)) {
            // A chunk is a text fragment, not a standalone document — embedding it under the
            // entry's mimetype (e.g. application/json) re-validates the partial and throws.
            // The vector is over tokens; embed every tile as plain text.
            const e = await mimetypes.process({ content: spec.text, hint: "text/plain" }, { channels: ["embedding"] });
            if (e.embedding !== undefined && e.embedding.byteLength > 0) {
                chunks.push({ lineStart: spec.lineStart, lineEnd: spec.lineEnd, vector: e.embedding });
                model = e.embeddingModel;
            }
        }
        return { chunks, model };
    }

    // Chunk budget in tokens — `.env.example` is the law, no code fallback. EMPTY =
    // the embedder's reported window (scalable — NO model-specific number baked in);
    // a positive value caps BELOW the window (e.g. to sweep granularity).
    static #chunkBudget(maxTokens: number): number {
        const raw = process.env.PLURNK_SEMANTIC_CHUNK_TOKENS;
        if (raw === undefined || raw.trim() === "") return maxTokens;
        const v = Number(raw);
        if (!Number.isInteger(v) || v < 1) throw new Error(`PLURNK_SEMANTIC_CHUNK_TOKENS must be empty (= the embedder's window) or a positive integer, got ${JSON.stringify(raw)}`);
        return Math.min(v, maxTokens);
    }

    static #chunkOverlap(): number {
        const v = Number(process.env.PLURNK_SEMANTIC_CHUNK_OVERLAP);
        if (!(v >= 0 && v < 1)) throw new Error(`PLURNK_SEMANTIC_CHUNK_OVERLAP must be in [0,1), got ${JSON.stringify(process.env.PLURNK_SEMANTIC_CHUNK_OVERLAP)}`);
        return v;
    }

    // The embedder capability surface (daughter window + tokenizer), probed through
    // the Mimetypes handle. null until plurnk-mimetypes-embeddings#1 lands.
    static async #embedderInfo(mimetypes: Mimetypes): Promise<{ maxTokens: number; countTokens: (text: string) => Promise<number> } | null> {
        return (await (mimetypes as { embedderInfo?: () => Promise<{ maxTokens: number; countTokens: (text: string) => Promise<number> } | null> }).embedderInfo?.()) ?? null;
    }

    // Folded into the entry's deep_hash so a derivation re-runs when the EMBEDDING
    // inputs change, not just content: installing/swapping the embedder (the window
    // flips none→N, activating tiling) or sweeping the chunk knobs. Config is excluded
    // while dormant — it can't affect a single whole-entry chunk.
    static async deepConfigSignature(mimetypes: Mimetypes): Promise<string> {
        const info = await EntrySemantic.#embedderInfo(mimetypes);
        if (info === null) return "embed:none";
        return `embed:${info.maxTokens}:${EntrySemantic.#chunkBudget(info.maxTokens)}:${EntrySemantic.#chunkOverlap()}`;
    }

    // Build the FTS5 narrow from a ~query: OR the alphanumeric terms (a broad cut —
    // cosine does the precision). FTS5-syntax-safe (bare lowercased terms).
    static ftsQueryFor(text: string): string {
        const terms = text.toLowerCase().match(/[a-z0-9]+/g);
        if (terms === null) return "";
        return [...new Set(terms)].join(" OR ");
    }

    // The ~query dispatch: embed the query text through the SAME channel, FTS-narrow
    // by its terms, cosine-rank the narrowed set, top-K. 501 when no embeddings
    // handler is installed (the channel degrades to `embeddingMissing`).
    static async rankSemantic(db: Db, sessionId: number, scheme: string | null, mimetypes: Mimetypes, queryText: string, marker: { first: number; last: number | null }): Promise<{ status: number; pathnames: string[] }> {
        const r = await mimetypes.process({ content: queryText, hint: "text/markdown" }, { channels: ["embedding"] });
        // No embedder installed → the channel degrades to empty bytes (not undefined);
        // an empty query vector can't rank, so surface 501 rather than a false 200.
        if (r.embedding === undefined || r.embedding.byteLength === 0 || r.embeddingModel === undefined) return { status: 501, pathnames: [] };
        const ftsQuery = EntrySemantic.ftsQueryFor(queryText);
        if (ftsQuery.length === 0) return { status: 200, pathnames: [] };
        // #209 — the result marker form-dispatches: integer <K> → top-K rank;
        // decimal <0.x> → a similarity threshold (minimum cosine in (0,1)), with
        // <0.x,N> capping the threshold set at N (else unbounded). A fractional
        // value outside (0,1) is a nonsense result-marker → 416, never coerced.
        const { first, last } = marker;
        if (Number.isInteger(first)) {
            const rows = await (db.semantic_rank as PrepMethod).all<{ pathname: string }>({
                fts_query: ftsQuery, session_id: sessionId, scheme, query_vector: r.embedding, embedding_model: r.embeddingModel, k: first,
            });
            return { status: 200, pathnames: rows.map((x) => x.pathname) };
        }
        if (first <= 0 || first >= 1) return { status: 416, pathnames: [] };
        const cap = (last !== null && Number.isInteger(last) && last > 0) ? last : -1;
        const rows = await (db.semantic_rank_threshold as PrepMethod).all<{ pathname: string }>({
            fts_query: ftsQuery, session_id: sessionId, scheme, query_vector: r.embedding, embedding_model: r.embeddingModel, threshold: first, cap,
        });
        return { status: 200, pathnames: rows.map((x) => x.pathname) };
    }
}
