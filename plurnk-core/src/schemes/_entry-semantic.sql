-- ~semantic (plurnk-service#186): exhaustive cosine ranking over every complete
-- derivation in scope. FTS is retained only as the explicit no-embedder fallback;
-- it never gates vector recall.

-- PREP: fts_delete
DELETE FROM entry_fts WHERE rowid = $derivation_id;

-- PREP: fts_insert
INSERT INTO entry_fts (rowid, content) VALUES ($derivation_id, $content);

-- PREP: embedding_set
-- Insert ONE chunk's vector + its <L> extent + the model. The caller clears the
-- entry's rows (embedding_delete) first and inserts each chunk in seq order, so no
-- upsert is needed — a re-derivation is delete-all then insert-each.
INSERT INTO entry_embeddings (derivation_id, chunk_seq, line_start, line_end, vector, embedding_model)
VALUES ($derivation_id, $chunk_seq, $line_start, $line_end, $vector, $embedding_model);

-- PREP: embedding_delete
-- Clears ALL of an entry's chunk rows (the re-derivation reset).
DELETE FROM entry_embeddings WHERE derivation_id = $derivation_id;

-- PREP: semantic_rank
-- Exhaustive cosine rank over every vector in the workspace+scheme scope.
-- Many chunk rows per entry → rank by the entry's BEST chunk (per-entry top cosine via
-- ROW_NUMBER), and surface that winning chunk's line span as the finding extent
-- (Project Findings). embedding_model filter keeps cosine within one model's dimensions.
WITH ranked AS (
    SELECT e.pathname, em.line_start, em.line_end,
           cosine(em.vector, $query_vector) AS score,
           ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY cosine(em.vector, $query_vector) DESC) AS rn
    FROM derivations d
    JOIN entries e ON e.deep_hash = d.deep_hash
    JOIN entry_embeddings em ON em.derivation_id = d.id AND em.embedding_model = $embedding_model
    WHERE d.state = 'complete'
      AND e.workspace_id = $workspace_id
      AND e.scheme = $scheme
      AND e.id IN (SELECT value FROM json_each($entry_ids))
)
SELECT pathname, line_start, line_end FROM ranked
WHERE rn = 1
ORDER BY score DESC
LIMIT $k;

-- PREP: semantic_rank_threshold
-- #209 — the <0.x> similarity-threshold form: same exhaustive cosine rank, but a cosine
-- floor ($threshold, in (0,1)) replaces top-K, and $cap (-1 = unbounded) is the
-- optional <0.x,N> result cap.
WITH ranked AS (
    SELECT e.pathname, em.line_start, em.line_end,
           cosine(em.vector, $query_vector) AS score,
           ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY cosine(em.vector, $query_vector) DESC) AS rn
    FROM derivations d
    JOIN entries e ON e.deep_hash = d.deep_hash
    JOIN entry_embeddings em ON em.derivation_id = d.id AND em.embedding_model = $embedding_model
    WHERE d.state = 'complete'
      AND e.workspace_id = $workspace_id
      AND e.scheme = $scheme
      AND e.id IN (SELECT value FROM json_each($entry_ids))
)
SELECT pathname, line_start, line_end FROM ranked
WHERE rn = 1 AND score >= $threshold
ORDER BY score DESC
LIMIT $cap;

-- PREP: semantic_rank_fts
-- FTS-only fallback when no embedder is installed: rank processed readable content by BM25
-- relevance alone (no entry_embeddings join, no cosine), scheme-scoped, top-K. Without
-- chunk vectors there is no winning span, so the finding is the whole entry — line
-- 1..its line count, derived from the indexed FTS content.
SELECT e.pathname,
       1 AS line_start,
       length(f.content) - length(replace(f.content, char(10), '')) + 1 AS line_end
FROM entry_fts f
JOIN derivations d ON d.id = f.rowid AND d.state = 'complete'
JOIN entries e ON e.deep_hash = d.deep_hash
WHERE f.content MATCH $fts_query
  AND e.workspace_id = $workspace_id
  AND e.scheme = $scheme
  AND e.id IN (SELECT value FROM json_each($entry_ids))
ORDER BY bm25(entry_fts)
LIMIT $k;
