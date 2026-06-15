-- ~semantic (plurnk-service#186) — the FTS half of the dialect (FTS narrow →
-- cosine rank). Populated at the gated manifest-add hook; the FTS5 rowid IS the
-- entry id, so a re-index is delete-by-rowid then insert.

-- PREP: fts_delete
DELETE FROM entry_fts WHERE rowid = $entry_id;

-- PREP: fts_insert
INSERT INTO entry_fts (rowid, content) VALUES ($entry_id, $content);

-- PREP: embedding_set
-- Insert ONE chunk's vector + its <L> extent + the model. The caller clears the
-- entry's rows (embedding_delete) first and inserts each chunk in seq order, so no
-- upsert is needed — a re-derivation is delete-all then insert-each.
INSERT INTO entry_embeddings (entry_id, chunk_seq, line_start, line_end, vector, embedding_model)
VALUES ($entry_id, $chunk_seq, $line_start, $line_end, $vector, $embedding_model);

-- PREP: embedding_delete
-- Clears ALL of an entry's chunk rows (the re-derivation reset).
DELETE FROM entry_embeddings WHERE entry_id = $entry_id;

-- PREP: semantic_rank
-- The ~semantic fusion: FTS narrows by keyword ($fts_query), then cosine ranks the
-- narrowed candidates over the query embedding ($query_vector), top-K. Scheme-scoped
-- like every dialect. FTS does the scale-cut; cosine the precise rank — so a high-
-- cosine entry that doesn't match the keyword is correctly excluded by the narrow.
-- Many chunk rows per entry now → GROUP BY entry and rank by the entry's BEST chunk
-- (max-pool). embedding_model filter keeps cosine within one model's dimensions.
SELECT e.pathname
FROM entry_fts f
JOIN entries e ON e.id = f.rowid
JOIN entry_embeddings em ON em.entry_id = e.id AND em.embedding_model = $embedding_model
WHERE f.content MATCH $fts_query
  AND e.session_id = $session_id
  AND e.scheme IS $scheme
GROUP BY e.id
ORDER BY MAX(cosine(em.vector, $query_vector)) DESC
LIMIT $k;

-- PREP: semantic_rank_threshold
-- #209 — the <0.x> similarity-threshold form: same FTS+cosine fusion, but a cosine
-- floor ($threshold, in (0,1)) replaces top-K, and $cap (-1 = unbounded) is the
-- optional <0.x,N> result cap.
SELECT e.pathname
FROM entry_fts f
JOIN entries e ON e.id = f.rowid
JOIN entry_embeddings em ON em.entry_id = e.id AND em.embedding_model = $embedding_model
WHERE f.content MATCH $fts_query
  AND e.session_id = $session_id
  AND e.scheme IS $scheme
GROUP BY e.id
HAVING MAX(cosine(em.vector, $query_vector)) >= $threshold
ORDER BY MAX(cosine(em.vector, $query_vector)) DESC
LIMIT $cap;
