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
-- Many chunk rows per entry → rank by the entry's BEST chunk (per-entry top cosine via
-- ROW_NUMBER), and surface that winning chunk's line span as the finding extent
-- (Project Findings). embedding_model filter keeps cosine within one model's dimensions.
WITH ranked AS (
    SELECT e.pathname, em.line_start, em.line_end,
           cosine(em.vector, $query_vector) AS score,
           ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY cosine(em.vector, $query_vector) DESC) AS rn
    FROM entry_fts f
    JOIN entries e ON e.id = f.rowid
    JOIN entry_embeddings em ON em.entry_id = e.id AND em.embedding_model = $embedding_model
    WHERE f.content MATCH $fts_query
      AND e.workspace_id = $workspace_id
      AND e.scheme = $scheme
)
SELECT pathname, line_start, line_end FROM ranked
WHERE rn = 1
ORDER BY score DESC
LIMIT $k;

-- PREP: semantic_rank_threshold
-- #209 — the <0.x> similarity-threshold form: same FTS+cosine fusion, but a cosine
-- floor ($threshold, in (0,1)) replaces top-K, and $cap (-1 = unbounded) is the
-- optional <0.x,N> result cap.
WITH ranked AS (
    SELECT e.pathname, em.line_start, em.line_end,
           cosine(em.vector, $query_vector) AS score,
           ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY cosine(em.vector, $query_vector) DESC) AS rn
    FROM entry_fts f
    JOIN entries e ON e.id = f.rowid
    JOIN entry_embeddings em ON em.entry_id = e.id AND em.embedding_model = $embedding_model
    WHERE f.content MATCH $fts_query
      AND e.workspace_id = $workspace_id
      AND e.scheme = $scheme
)
SELECT pathname, line_start, line_end FROM ranked
WHERE rn = 1 AND score >= $threshold
ORDER BY score DESC
LIMIT $cap;

-- PREP: semantic_rank_fts
-- FTS-only fallback when no embedder is installed: rank entry_fts by BM25 keyword
-- relevance alone (no entry_embeddings join, no cosine), scheme-scoped, top-K. Without
-- chunk vectors there is no winning span, so the finding is the whole entry — line
-- 1..its line count, derived from the indexed FTS content.
SELECT e.pathname,
       1 AS line_start,
       length(f.content) - length(replace(f.content, char(10), '')) + 1 AS line_end
FROM entry_fts f
JOIN entries e ON e.id = f.rowid
WHERE f.content MATCH $fts_query
  AND e.workspace_id = $workspace_id
  AND e.scheme = $scheme
ORDER BY rank
LIMIT $k;

-- PREP: semantic_fts_candidates
-- §semantic-cold-query-full-fidelity — the FTS-narrowed candidate slice, BM25-ordered,
-- with the derivation inputs (content/mimetype/deep_hash) so the caller can derive any
-- stale candidate INLINE before ranking. Ranking only ever scores this narrowed set, so
-- embedding exactly this slice on demand gives bit-identical results to a warm corpus.
SELECT e.id AS entry_id, e.pathname, ec.content, ec.mimetype, e.deep_hash, 'body' AS channel
FROM entry_fts f
JOIN entries e ON e.id = f.rowid
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
WHERE f.content MATCH $fts_query
  AND e.workspace_id = $workspace_id
  AND e.scheme = $scheme
ORDER BY bm25(entry_fts)
LIMIT $cap;

-- PREP: embedding_by_content_hash
-- §semantic-embed-dedup (#416) — the chunk rows of ONE OTHER entry whose body content_hash
-- matches, already embedded under the active model. Identical content → identical embeddings, so
-- a duplicate (the metaproject's 15× tokenizer.json) copies instead of re-embedding. Picks the
-- newest such source entry; returns its chunks in seq order.
SELECT em.chunk_seq, em.line_start, em.line_end, em.vector
FROM entry_embeddings em
WHERE em.embedding_model = $embedding_model AND em.entry_id = (
    SELECT ec.entry_id FROM entry_channels ec
    JOIN entry_embeddings e2 ON e2.entry_id = ec.entry_id AND e2.embedding_model = $embedding_model
    WHERE ec.name = 'body' AND ec.content_hash = $content_hash AND ec.entry_id != $entry_id
    ORDER BY ec.entry_id DESC LIMIT 1)
ORDER BY em.chunk_seq ASC;
