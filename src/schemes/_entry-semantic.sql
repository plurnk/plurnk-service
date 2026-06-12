-- ~semantic (plurnk-service#186) — the FTS half of the dialect (FTS narrow →
-- cosine rank). Populated at the gated manifest-add hook; the FTS5 rowid IS the
-- entry id, so a re-index is delete-by-rowid then insert.

-- PREP: fts_delete
DELETE FROM entry_fts WHERE rowid = $entry_id;

-- PREP: fts_insert
INSERT INTO entry_fts (rowid, content) VALUES ($entry_id, $content);

-- PREP: embedding_set
-- Upsert an entry's embedding vector + the model that produced it (one per entry),
-- supplied by the mimetypes `embedding` projection at the gated manifest-add hook.
INSERT INTO entry_embeddings (entry_id, vector, embedding_model) VALUES ($entry_id, $vector, $embedding_model)
ON CONFLICT(entry_id) DO UPDATE SET vector = excluded.vector, embedding_model = excluded.embedding_model;

-- PREP: embedding_delete
DELETE FROM entry_embeddings WHERE entry_id = $entry_id;

-- PREP: semantic_rank
-- The ~semantic fusion: FTS narrows by keyword ($fts_query), then cosine ranks the
-- narrowed candidates over the query embedding ($query_vector), top-K. Scheme-scoped
-- like every dialect. FTS does the scale-cut; cosine the precise rank — so a high-
-- cosine entry that doesn't match the keyword is correctly excluded by the narrow.
SELECT e.pathname
FROM entry_fts f
JOIN entries e ON e.id = f.rowid
JOIN entry_embeddings em ON em.entry_id = e.id
WHERE f.content MATCH $fts_query
  AND e.session_id = $session_id
  AND e.scheme IS $scheme
ORDER BY cosine(em.vector, $query_vector) DESC
LIMIT $k;
