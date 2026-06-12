// ~semantic (plurnk-service#186) — the FTS half. Re-indexes an entry's body
// content into entry_fts (the keyword/narrowing half of the fusion). The cosine
// rank over embedding vectors — the precise half — lands when the embedding
// channel does (a daughter projection, per the §4 boundary). Called from the
// gated manifest-add hook, so only when body content actually changed.

import type { Db, PrepMethod } from "../core/Db.ts";

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
}
