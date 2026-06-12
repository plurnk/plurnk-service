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
}
