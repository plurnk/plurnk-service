// ~semantic storage and ranking. Complete content-addressed derivations own the
// reader-projected FTS, graph, and vectors. Vector search ranks every eligible
// vector in scope; FTS is only the explicit no-embedder fallback.

import type { Db, PrepMethod } from "../core/Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";

// mimetypes' package entry doesn't re-export EmbedderInfo (asked on mimetypes#51) — project it
// from the contract method itself so this stays the REAL type, never a local fiction.
type EmbedderInfo = NonNullable<Awaited<ReturnType<Mimetypes["embedderInfo"]>>>;
import EntryChunk from "./_entry-chunk.ts";

export default class EntrySemantic {
    static defaultTopK(): number {
        const raw = process.env.PLURNK_SERVICE_SEMANTIC_TOP_K;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new Error(`PLURNK_SERVICE_SEMANTIC_TOP_K must be a positive safe integer, got ${JSON.stringify(raw)}`);
        }
        return value;
    }

    static maxEmbedSize(): number {
        const raw = process.env.PLURNK_SERVICE_MAX_EMBED_SIZE;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`PLURNK_SERVICE_MAX_EMBED_SIZE must be a non-negative safe integer byte count (0 = unlimited), got ${JSON.stringify(raw)}`);
        }
        return value;
    }

    static embedSizeRejection(content: string): { actualBytes: number; maxBytes: number } | null {
        const maxBytes = EntrySemantic.maxEmbedSize();
        if (maxBytes === 0) return null;
        const actualBytes = Buffer.byteLength(content, "utf8");
        return actualBytes > maxBytes ? { actualBytes, maxBytes } : null;
    }

    // Replace a derivation artifact's FTS row with its readable content.
    // Empty content (binary member / cleared entry) → no FTS row (delete only).
    static async indexFts(db: Db, derivationId: number, content: string): Promise<void> {
        await (db.fts_delete as PrepMethod).run({ derivation_id: derivationId });
        if (content.length > 0) await (db.fts_insert as PrepMethod).run({ derivation_id: derivationId, content });
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

    // Store a derivation's embedding vectors + model, or clear them.
    // row (binary/empty entry, or a degraded `embeddingMissing` projection). Called
    // from the gated manifest-add hook beside indexFts / the symbol index.
    static async indexEmbedding(db: Db, derivationId: number, chunks: { lineStart: number; lineEnd: number; vector: Uint8Array }[], model: string | undefined): Promise<void> {
        // Re-derivation = clear all of the artifact's chunk rows, then insert each in seq
        // order. No model (no embedder installed) or no chunks → just cleared.
        await (db.embedding_delete as PrepMethod).run({ derivation_id: derivationId });
        if (model === undefined) return;
        for (const [seq, c] of chunks.entries()) {
            await (db.embedding_set as PrepMethod).run({
                derivation_id: derivationId, chunk_seq: seq, line_start: c.lineStart, line_end: c.lineEnd,
                vector: c.vector, embedding_model: model,
            });
        }
    }

    // Project Semantics — derive an entry's chunk embeddings. Probes the embedder
    // capability (the plugin's window + tokenizer, surfaced via the Mimetypes
    // handle): ABSENT → one whole-entry chunk from the fallback vector (today's
    // behavior, no extra embed call); PRESENT → lossless tile, embed each chunk.
    // Returns the chunk list + model for indexEmbedding; never touches the DB.
    static async deriveEmbeddings(
        mimetypes: Mimetypes,
        content: string,
        symbols: readonly { line?: number; endLine?: number }[],
        fallbackEmbedding: Uint8Array | undefined,
        fallbackModel: string | undefined,
        signal?: AbortSignal,
        onProgress?: (progress: { phase: "planning" | "embedding"; completed: number; total: number }) => void,
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
        // mimetypes#50 — a REMOTE embedder is present with an incomplete self-report: the window
        // is the operator's to declare (their knob), and the counter resolves through the seam's
        // tokenizers by the embedder's model name — the chars/2 upper bound when inexact is the
        // surfaced conservative fallback (smaller chunks are correct chunks).
        if (info.contextWindow === null) throw new Error("remote embedder reports no input context window — set PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW to the endpoint's limit");
        const counter = info.countTokens ?? (await mimetypes.tokenizer(info.model ?? "")).countTokens;
        const budget = EntrySemantic.#chunkBudget(info.contextWindow);
        let specs = await EntryChunk.tile(
            content,
            boundaries,
            budget,
            EntrySemantic.#chunkOverlap(),
            counter,
            (progress) => onProgress?.({ phase: "planning", ...progress }),
        );
        if (specs.length === 0) return { chunks: [], model: undefined };
        // One data-parallel batch over the tiled chunk texts (#272 — embedBatch via the
        // framework seam, ~6× the per-chunk loop on a multi-core box; vectors bit-identical,
        // so no re-embed). Each tile embeds as PLAIN TEXT: a chunk is a fragment, not a
        // standalone document, so embedding under the entry's mimetype (e.g. application/json)
        // re-validates the partial and throws — embedBatch embeds raw text directly.
        const vectors = await mimetypes.embedBatch(specs.map((s) => s.text), {
            signal,
            onProgress: (progress) => onProgress?.({ phase: "embedding", ...progress }),
        });
        const chunks: { lineStart: number; lineEnd: number; vector: Uint8Array }[] = [];
        for (const [i, spec] of specs.entries()) {
            const vector = vectors[i];
            if (vector !== undefined && vector.byteLength > 0) chunks.push({ lineStart: spec.lineStart, lineEnd: spec.lineEnd, vector });
        }
        return { chunks, model: chunks.length > 0 ? info.model : undefined };
    }

    // Chunk budget in tokens — `.env.defaults` is the law, no code fallback. EMPTY =
    // the embedder's reported window (scalable — NO model-specific number baked in);
    // a positive value caps BELOW the window (e.g. to sweep granularity).
    static #chunkBudget(contextWindow: number): number {
        const raw = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
        if (raw === undefined || raw.trim() === "") return contextWindow;
        const v = Number(raw);
        if (!Number.isInteger(v) || v < 1) throw new Error(`PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS must be empty (= the embedder's window) or a positive integer, got ${JSON.stringify(raw)}`);
        return Math.min(v, contextWindow);
    }

    static #chunkOverlap(): number {
        const v = Number(process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_OVERLAP);
        if (!(v >= 0 && v < 1)) throw new Error(`PLURNK_SERVICE_SEMANTIC_CHUNK_OVERLAP must be in [0,1), got ${JSON.stringify(process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_OVERLAP)}`);
        return v;
    }

    // The embedder capability surface (plugin window + tokenizer + model id), probed
    // through the Mimetypes handle. null until an embedder is installed.
    static async #embedderInfo(mimetypes: Mimetypes): Promise<EmbedderInfo | null> {
        // PLURNK_SERVICE_EMBED_DISABLE=1 forces the no-embedder path even when the optional embeddings package
        // IS installed — the whole semantic stack (deriveEmbeddings, exhaustive ~query cosine rank, the
        // deep_hash config) funnels through here, so one gate makes everything FTS-only. The fast lane
        // (mock-provider tests) sets it so the suite doesn't spin up the MiniLM worker pool for nothing.
        if (process.env.PLURNK_SERVICE_EMBED_DISABLE === "1") return null;
        return await mimetypes.embedderInfo();
    }

    // Folded into the entry's deep_hash so a derivation re-runs when the EMBEDDING
    // inputs change, not just content: installing/swapping the embedder (the window
    // flips none→N, activating tiling), the embedder's model id changing at the SAME
    // window (#31 — else stale vectors from the old model's space survive the swap and
    // get cosine-compared against the new model's), or sweeping the chunk knobs.
    static async deepConfigSignature(mimetypes: Mimetypes): Promise<string> {
        const info = await EntrySemantic.#embedderInfo(mimetypes);
        if (info === null) return "embed:none";
        const base = `embed:${info.model ?? "?"}:${info.contextWindow}:${info.contextWindow === null ? "?" : EntrySemantic.#chunkBudget(info.contextWindow)}:${EntrySemantic.#chunkOverlap()}`;
        const maxBytes = EntrySemantic.maxEmbedSize();
        return maxBytes === 0 ? base : `${base}:max-bytes=${maxBytes}`;
    }

    // Build the FTS5 query used only by the no-embedder keyword fallback.
    static ftsQueryFor(text: string): string {
        const terms = text.toLowerCase().match(/[a-z0-9]+/g);
        if (terms === null) return "";
        return [...new Set(terms)].join(" OR ");
    }

    // The ~query dispatch: embed the query text through the SAME channel and cosine-rank
    // every vector in scope, top-K. Each result carries its best-matching
    // chunk's line span (the Finding extent). No embedder → the top-K <K> form degrades to an
    // FTS-only keyword rank (whole-entry findings); the <0.x> threshold form stays 501.
    static async rankSemantic(db: Db, workspaceId: number, scheme: string | null, entryIds: readonly number[], mimetypes: Mimetypes, queryText: string, marker: { first: number; last: number | null }): Promise<{ status: number; results: Array<{ pathname: string; lineStart: number; lineEnd: number }> }> {
        // #209 — the result marker form-dispatches: integer <K> → top-K rank;
        // decimal <0.x> → a similarity threshold (minimum cosine in (0,1)), with
        // <0.x,N> capping the threshold set at N (else unbounded). A fractional
        // value outside (0,1) is a nonsense result-marker → 416, never coerced.
        const { first, last } = marker;
        const toResult = (x: { pathname: string; line_start: number; line_end: number }) => ({ pathname: x.pathname, lineStart: x.line_start, lineEnd: x.line_end });
        if (entryIds.length === 0) return { status: 200, results: [] };
        const entry_ids = JSON.stringify(entryIds);

        // The query embedding honors the SAME gate as the corpus (#embedderInfo /
        // PLURNK_SERVICE_EMBED_DISABLE): with the embeddings package installed but disabled,
        // calling process() directly would compute a query vector and rank it against
        // an empty entry_embeddings — every ~query silently []. Disabled → the honest
        // FTS keyword fallback, same as no embedder at all.
        const info = await EntrySemantic.#embedderInfo(mimetypes);
        const r = info === null
            ? { embedding: undefined, embeddingModel: undefined }
            : await mimetypes.process({ content: queryText, hint: "text/markdown" }, { channels: ["embedding"] });
        if (r.embedding === undefined || r.embedding.byteLength === 0 || r.embeddingModel === undefined) {
            // FTS fallback: no embedder, so there is no query vector to cosine with. Top-K ranks
            // by BM25 keyword relevance alone; the <0.x> threshold form is intrinsically cosine-
            // based (no bounded BM25 analogue) → it stays 501.
            if (!Number.isInteger(first)) return { status: 501, results: [] };
            const ftsQuery = EntrySemantic.ftsQueryFor(queryText);
            if (ftsQuery.length === 0) return { status: 200, results: [] };
            const rows = await (db.semantic_rank_fts as PrepMethod).all<{ pathname: string; line_start: number; line_end: number }>({
                fts_query: ftsQuery, workspace_id: workspaceId, scheme, entry_ids, k: first,
            });
            return { status: 200, results: rows.map(toResult) };
        }
        if (Number.isInteger(first)) {
            const rows = await (db.semantic_rank as PrepMethod).all<{ pathname: string; line_start: number; line_end: number }>({
                workspace_id: workspaceId, scheme, entry_ids, query_vector: r.embedding, embedding_model: r.embeddingModel, k: first,
            });
            return { status: 200, results: rows.map(toResult) };
        }
        if (first <= 0 || first >= 1) return { status: 416, results: [] };
        const cap = (last !== null && Number.isInteger(last) && last > 0) ? last : -1;
        const rows = await (db.semantic_rank_threshold as PrepMethod).all<{ pathname: string; line_start: number; line_end: number }>({
            workspace_id: workspaceId, scheme, entry_ids, query_vector: r.embedding, embedding_model: r.embeddingModel, threshold: first, cap,
        });
        return { status: 200, results: rows.map(toResult) };
    }
}
