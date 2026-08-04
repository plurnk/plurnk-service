// ~semantic storage and ranking. Complete content-addressed derivations own the
// exact READ-body FTS, graph, and vectors. Vector search ranks every eligible
// vector in scope; FTS is only the explicit no-embedder fallback.

import type { Db } from "../core/Db.ts";
import type { LineMarker } from "@plurnk/plurnk-contracts";
import {
    TextCoordinates,
    type Mimetypes,
    type TokenizerResolution,
} from "@plurnk/plurnk-mimetypes";

// mimetypes' package entry doesn't re-export EmbedderInfo (asked on mimetypes#51) — project it
// from the contract method itself so this stays the REAL type, never a local fiction.
type EmbedderInfo = NonNullable<Awaited<ReturnType<Mimetypes["embedderInfo"]>>>;
import EntryChunk from "./_entry-chunk.ts";
import type { SearchCandidate } from "./_search-candidate.ts";

export interface SemanticPlan {
    readonly mimetypes: Mimetypes;
    readonly info: EmbedderInfo | null;
    readonly countTokens: ((text: string) => Promise<number>) | null;
    readonly tokenizer: TokenizerResolution | null;
    readonly signature: string;
}

type SemanticResultSelection = {
    threshold: number | null;
    page: LineMarker | null;
    limit: number;
};

export default class EntrySemantic {
    static defaultTopK(): number {
        const raw = process.env.PLURNK_SERVICE_SEMANTIC_TOP_K;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new Error(`PLURNK_SERVICE_SEMANTIC_TOP_K must be a positive safe integer, got ${JSON.stringify(raw)}`);
        }
        return value;
    }

    // FIND owns result positions uniformly across matcher dialects. Semantic
    // search adds only an optional leading decimal threshold; any remaining
    // integers retain the ordinary FIND positional meaning. The rank query
    // needs only the prefix ending at the requested page, while an open-ended
    // or malformed page remains exhaustive so the shared pager can report the
    // authoritative result extent.
    static resultSelection(marker: LineMarker | null): SemanticResultSelection {
        if (marker === null) {
            return { threshold: null, page: null, limit: EntrySemantic.defaultTopK() };
        }
        const [first, ...remaining] = marker.marks;
        if (Number.isInteger(first)) {
            return {
                threshold: null,
                page: marker,
                limit: EntrySemantic.#pageLimit(marker),
            };
        }
        const page = remaining.length === 0
            ? null
            : { marks: remaining as [number, ...number[]] };
        return {
            threshold: first,
            page,
            limit: page === null ? -1 : EntrySemantic.#pageLimit(page),
        };
    }

    static #pageLimit(marker: LineMarker): number {
        if (marker.marks.length !== 1 && marker.marks.length !== 2) return -1;
        const [first, last] = marker.marks;
        if (!Number.isInteger(first) || (last !== undefined && !Number.isInteger(last))) return -1;
        if (last === undefined) return first >= 0 ? first : -1;
        if (last === -1) return -1;
        if (first < 0 || first > last || last < 1) return -1;
        return last;
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
        await db.fts_delete.run({ derivation_id: derivationId });
        if (content.length > 0) await db.fts_insert.run({ derivation_id: derivationId, content });
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
        await db.embedding_delete.run({ derivation_id: derivationId });
        if (model === undefined) return;
        for (const [seq, c] of chunks.entries()) {
            await db.embedding_set.run({
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
        plan: SemanticPlan,
        content: string,
        symbols: readonly { line?: number; endLine?: number }[],
        fallbackEmbedding: Uint8Array | undefined,
        fallbackModel: string | undefined,
        signal?: AbortSignal,
        onProgress?: (progress: { phase: "planning" | "embedding"; completed: number; total: number }) => void,
    ): Promise<{ chunks: { lineStart: number; lineEnd: number; vector: Uint8Array }[]; model: string | undefined }> {
        const { info } = plan;
        if (info === null) {
            const totalLines = TextCoordinates.logicalLines(content).length;
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
        // A remote embedder may omit its own counter. The pass-wide semantic plan
        // preserves the one fallback tokenizer resolution, including identity and
        // exactness; {§semantic-embed-dedup} owns its derivation identity and #95
        // owns whether an inexact resolution may authorize chunking.
        if (info.contextWindow === null) throw new Error("remote embedder reports no input context window — set PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW to the endpoint's limit");
        const counter = plan.countTokens;
        if (counter === null) throw new Error("semantic plan has no token counter for an embedder with a declared context window");
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
        const vectors = await plan.mimetypes.embedBatch(specs.map((s) => s.text), {
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
    // through the Mimetypes handle. null means semantic derivation is unavailable.
    static async #embedderInfo(mimetypes: Mimetypes): Promise<EmbedderInfo | null> {
        // PLURNK_SERVICE_EMBED_DISABLE=1 forces the no-embedder path even though the default service
        // includes one. The semantic stack funnels through this gate, so disabling it is wholly FTS-only.
        if (process.env.PLURNK_SERVICE_EMBED_DISABLE === "1") return null;
        return await mimetypes.embedderInfo();
    }

    // Resolve the pass-wide semantic facts once. The plan binds the selected
    // counter to the same identity folded into every derivation hash, so entries
    // cannot be tiled with provenance different from the configuration key.
    static async prepareEmbeddings(mimetypes: Mimetypes): Promise<SemanticPlan> {
        const info = await EntrySemantic.#embedderInfo(mimetypes);
        if (info === null) {
            return {
                mimetypes,
                info: null,
                countTokens: null,
                tokenizer: null,
                signature: "embed:none",
            };
        }
        const tokenizer = info.countTokens === null && info.contextWindow !== null
            ? await mimetypes.tokenizer(info.model ?? "")
            : null;
        const countTokens = info.countTokens ?? tokenizer?.countTokens ?? null;
        const tokenizerIdentity = tokenizer === null ? "" : `:tokenizer=${tokenizer.tokenizerId}`;
        const base = `embed:${info.model ?? "?"}:${info.contextWindow}:${info.contextWindow === null ? "?" : EntrySemantic.#chunkBudget(info.contextWindow)}:${EntrySemantic.#chunkOverlap()}${tokenizerIdentity}`;
        const maxBytes = EntrySemantic.maxEmbedSize();
        return {
            mimetypes,
            info,
            countTokens,
            tokenizer,
            signature: maxBytes === 0 ? base : `${base}:max-bytes=${maxBytes}`,
        };
    }

    // Build the FTS5 query used only by the no-embedder keyword fallback.
    static ftsQueryFor(text: string): string {
        const terms = text.toLowerCase().match(/[a-z0-9]+/g);
        if (terms === null) return "";
        return [...new Set(terms)].join(" OR ");
    }

    // The ~query dispatch: embed the query text through the SAME channel and cosine-rank
    // every vector in scope. Each result carries its best-matching
    // chunk's line span (the Finding extent). No embedder -> an unthresholded
    // ranked prefix degrades to FTS-only keyword rank (whole-entry findings);
    // a similarity threshold stays 501.
    static async rankCandidates(
        db: Db,
        candidates: readonly SearchCandidate[],
        mimetypes: Mimetypes,
        queryText: string,
        selection: Pick<SemanticResultSelection, "threshold" | "limit">,
    ): Promise<{ status: number; results: Array<{ key: string; lineStart: number; lineEnd: number }> }> {
        const { threshold, limit } = selection;
        const toResult = (x: { key: string; line_start: number; line_end: number }) => ({
            key: x.key,
            lineStart: x.line_start,
            lineEnd: x.line_end,
        });
        if (threshold !== null && (threshold <= 0 || threshold >= 1)) {
            return { status: 416, results: [] };
        }
        if (candidates.length === 0) return { status: 200, results: [] };
        const serializedCandidates = JSON.stringify(candidates);

        // The query embedding honors the SAME gate as the corpus (#embedderInfo /
        // PLURNK_SERVICE_EMBED_DISABLE): with the embeddings package installed but disabled,
        // calling process() directly would compute a query vector and rank it against
        // an empty derivation_embeddings - every ~query silently []. Disabled means the honest
        // FTS keyword fallback, same as no embedder at all.
        const info = await EntrySemantic.#embedderInfo(mimetypes);
        const r = info === null
            ? { embedding: undefined, embeddingModel: undefined }
            : await mimetypes.process({ content: queryText, hint: "text/markdown" }, { channels: ["embedding"] });
        if (r.embedding === undefined || r.embedding.byteLength === 0 || r.embeddingModel === undefined) {
            // FTS fallback: no embedder, so there is no query vector to cosine with. Top-K ranks
            // by BM25 keyword relevance alone; the <0.x> threshold form is intrinsically cosine-
            // based (no bounded BM25 analogue), so it stays 501.
            if (threshold !== null) return { status: 501, results: [] };
            const ftsQuery = EntrySemantic.ftsQueryFor(queryText);
            if (ftsQuery.length === 0) return { status: 200, results: [] };
            const rows = await db.semantic_rank_candidates_fts.all<{ key: string; line_start: number; line_end: number }>({
                fts_query: ftsQuery,
                candidates: serializedCandidates,
                k: limit,
            });
            return { status: 200, results: rows.map(toResult) };
        }
        if (threshold === null) {
            const rows = await db.semantic_rank_candidates.all<{ key: string; line_start: number; line_end: number }>({
                candidates: serializedCandidates,
                query_vector: r.embedding,
                embedding_model: r.embeddingModel,
                k: limit,
            });
            return { status: 200, results: rows.map(toResult) };
        }
        const rows = await db.semantic_rank_candidates_threshold.all<{ key: string; line_start: number; line_end: number }>({
            candidates: serializedCandidates,
            query_vector: r.embedding,
            embedding_model: r.embeddingModel,
            threshold,
            cap: limit,
        });
        return { status: 200, results: rows.map(toResult) };
    }
}
