// [§semantic-embed-dedup] #416 — identical body content embeds ONCE; a duplicate entry copies the
// existing vectors instead of re-embedding (the metaproject's 15× tokenizer.json → 1×). Tests the
// dedup SOURCE query directly (no embedder needed): given a content_hash + model, it returns the
// chunk rows of another entry that shares the content — the rows the pump copies.
import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession } from "./_helpers.ts";
import { contentHash } from "../../src/core/content-hash.ts";

test("[§semantic-embed-dedup] the dedup source query returns a sibling's chunks for identical content (#416)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `dedup-${crypto.randomUUID()}`);
        const hash = contentHash("shared body content");
        // Entry A: a body channel stamped with the content_hash + an embedding under 'm1'.
        const a = (await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "known", pathname: "/a" }))!.id;
        await (db.test_seed_channel_hashed as PrepMethod).run({ entry_id: a, name: "body", content: "shared body content", mimetype: "text/markdown", content_hash: hash, state: "static" });
        await (db.embedding_set as PrepMethod).run({ entry_id: a, chunk_seq: 0, line_start: 1, line_end: 1, vector: new Uint8Array([9, 8, 7]), embedding_model: "m1" });
        // Entry B: same content_hash, not yet embedded.
        const b = (await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "known", pathname: "/b" }))!.id;
        await (db.test_seed_channel_hashed as PrepMethod).run({ entry_id: b, name: "body", content: "shared body content", mimetype: "text/markdown", content_hash: hash, state: "static" });

        // The dedup source query for B under m1 finds A's chunk.
        const rows = await (db.embedding_by_content_hash as PrepMethod).all<{ chunk_seq: number; vector: Uint8Array }>({ content_hash: hash, embedding_model: "m1", entry_id: b });
        assert.equal(rows.length, 1, "A's single chunk is offered as the reuse source");
        assert.deepEqual([...rows[0].vector], [9, 8, 7], "the exact sibling vector, to copy verbatim");

        // A different model → no reuse source (dimensions could differ; never cross-copy).
        const other = await (db.embedding_by_content_hash as PrepMethod).all<{ chunk_seq: number }>({ content_hash: hash, embedding_model: "m2", entry_id: b });
        assert.equal(other.length, 0, "reuse is per-model — a mismatched model finds nothing");

        // Distinct content → no source.
        const none = await (db.embedding_by_content_hash as PrepMethod).all<{ chunk_seq: number }>({ content_hash: contentHash("different"), embedding_model: "m1", entry_id: b });
        assert.equal(none.length, 0, "distinct content shares no embedding");
    } finally { await db.close(); }
});
