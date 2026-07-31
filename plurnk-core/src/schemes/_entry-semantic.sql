-- ~semantic (plurnk-service#186): exhaustive cosine ranking over every complete
-- derivation in scope. FTS is retained only as the explicit no-embedder fallback;
-- it never gates vector recall.

-- PREP: fts_delete
DELETE FROM derivation_fts WHERE rowid = $derivation_id;

-- PREP: fts_insert
INSERT INTO derivation_fts (rowid, content) VALUES ($derivation_id, $content);

-- PREP: embedding_set
-- Insert ONE chunk's vector + its <L> extent + the model. The caller clears the
-- entry's rows (embedding_delete) first and inserts each chunk in seq order, so no
-- upsert is needed — a re-derivation is delete-all then insert-each.
INSERT INTO derivation_embeddings (derivation_id, chunk_seq, line_start, line_end, vector, embedding_model)
VALUES ($derivation_id, $chunk_seq, $line_start, $line_end, $vector, $embedding_model);

-- PREP: embedding_delete
-- Clears ALL of an entry's chunk rows (the re-derivation reset).
DELETE FROM derivation_embeddings WHERE derivation_id = $derivation_id;

-- PREP: semantic_rank_candidates
-- Exhaustive cosine rank over caller-supplied address→derivation candidates.
-- Many chunk rows per resource → rank by its BEST chunk (per-resource top cosine via
-- ROW_NUMBER), and surface that winning chunk's line span as the finding extent
-- (Project Findings). embedding_model filter keeps cosine within one model's dimensions.
WITH candidates AS (
    SELECT json_extract(value, '$.key') AS key,
           json_extract(value, '$.deepHash') AS deep_hash
    FROM json_each($candidates)
),
ranked AS (
    SELECT c.key, em.line_start, em.line_end,
           cosine(em.vector, $query_vector) AS score,
           ROW_NUMBER() OVER (PARTITION BY c.key ORDER BY cosine(em.vector, $query_vector) DESC) AS rn
    FROM candidates c
    JOIN derivations d ON d.deep_hash = c.deep_hash
    JOIN derivation_embeddings em ON em.derivation_id = d.id AND em.embedding_model = $embedding_model
    WHERE d.state = 'complete'
)
SELECT key, line_start, line_end FROM ranked
WHERE rn = 1
ORDER BY score DESC
LIMIT $k;

-- PREP: semantic_rank_candidates_threshold
-- #209 — the <0.x> similarity-threshold form: same exhaustive cosine rank, but a cosine
-- floor ($threshold, in (0,1)) replaces top-K, and $cap (-1 = unbounded) is the
-- optional <0.x,N> result cap.
WITH candidates AS (
    SELECT json_extract(value, '$.key') AS key,
           json_extract(value, '$.deepHash') AS deep_hash
    FROM json_each($candidates)
),
ranked AS (
    SELECT c.key, em.line_start, em.line_end,
           cosine(em.vector, $query_vector) AS score,
           ROW_NUMBER() OVER (PARTITION BY c.key ORDER BY cosine(em.vector, $query_vector) DESC) AS rn
    FROM candidates c
    JOIN derivations d ON d.deep_hash = c.deep_hash
    JOIN derivation_embeddings em ON em.derivation_id = d.id AND em.embedding_model = $embedding_model
    WHERE d.state = 'complete'
)
SELECT key, line_start, line_end FROM ranked
WHERE rn = 1 AND score >= $threshold
ORDER BY score DESC
LIMIT $cap;

-- PREP: semantic_rank_candidates_fts
-- FTS-only fallback when no embedder is installed: rank the exact READ body by BM25
-- relevance alone (no derivation_embeddings join, no cosine). Without
-- chunk vectors there is no winning span, so the finding is the whole entry — line
-- 1..its line count, derived from the indexed FTS content.
WITH candidates AS (
    SELECT json_extract(value, '$.key') AS key,
           json_extract(value, '$.deepHash') AS deep_hash
    FROM json_each($candidates)
),
ranked AS (
    SELECT c.key,
           replace(replace(f.content, char(13) || char(10), char(10)), char(13), char(10)) AS content,
           bm25(derivation_fts) AS score
    FROM derivation_fts f
    JOIN derivations d ON d.id = f.rowid AND d.state = 'complete'
    JOIN candidates c ON c.deep_hash = d.deep_hash
    WHERE f.content MATCH $fts_query
)
SELECT key,
       1 AS line_start,
       CASE
           WHEN length(content) = 0 THEN 0
           ELSE length(content) - length(replace(content, char(10), ''))
               + CASE
                   WHEN substr(content, -1) = char(10) THEN 0
                   ELSE 1
               END
       END AS line_end
FROM ranked
ORDER BY score
LIMIT $k;
