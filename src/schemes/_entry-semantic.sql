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

-- PREP: semantic_rank_threshold
-- #209 — the <0.x> similarity-threshold form: same FTS+cosine fusion, but a cosine
-- floor ($threshold, in (0,1)) replaces top-K, and $cap (-1 = unbounded) is the
-- optional <0.x,N> result cap.
SELECT e.pathname
FROM entry_fts f
JOIN entries e ON e.id = f.rowid
JOIN entry_embeddings em ON em.entry_id = e.id
WHERE f.content MATCH $fts_query
  AND e.session_id = $session_id
  AND e.scheme IS $scheme
  AND cosine(em.vector, $query_vector) >= $threshold
ORDER BY cosine(em.vector, $query_vector) DESC
LIMIT $cap;
