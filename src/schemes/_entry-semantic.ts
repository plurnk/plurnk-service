// ~semantic (plurnk-service#186) — the FTS half. Re-indexes an entry's body
// content into entry_fts (the keyword/narrowing half of the fusion). The cosine
// rank over embedding vectors — the precise half — lands when the embedding
// channel does (a daughter projection, per the §mimetype boundary). Called from the
// gated manifest-add hook, so only when body content actually changed.

import type { Db, PrepMethod } from "../core/Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";

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
    static async indexEmbedding(db: Db, entryId: number, embedding: Uint8Array | undefined, model: string | undefined): Promise<void> {
        if (embedding !== undefined && model !== undefined) {
            await (db.embedding_set as PrepMethod).run({ entry_id: entryId, vector: embedding, embedding_model: model });
        } else {
            await (db.embedding_delete as PrepMethod).run({ entry_id: entryId });
        }
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
    static async rankSemantic(db: Db, sessionId: number, scheme: string | null, mimetypes: Mimetypes, queryText: string, k: number): Promise<{ status: number; pathnames: string[] }> {
        const r = await mimetypes.process({ content: queryText, hint: "text/markdown" }, { channels: ["embedding"] });
        // No embedder installed → the channel degrades to empty bytes (not undefined);
        // an empty query vector can't rank, so surface 501 rather than a false 200.
        if (r.embedding === undefined || r.embedding.byteLength === 0) return { status: 501, pathnames: [] };
        const ftsQuery = EntrySemantic.ftsQueryFor(queryText);
        if (ftsQuery.length === 0) return { status: 200, pathnames: [] };
        const rows = await (db.semantic_rank as PrepMethod).all<{ pathname: string }>({
            fts_query: ftsQuery, session_id: sessionId, scheme, query_vector: r.embedding, k,
        });
        return { status: 200, pathnames: rows.map((x) => x.pathname) };
    }
}
