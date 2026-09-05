-- {§find-fulltext-selection} Native FTS5 query and ranking over visible candidates.

-- PREP: fts_delete
DELETE FROM derivation_fts WHERE rowid = $derivation_id;

-- PREP: fts_insert
INSERT INTO derivation_fts (rowid, content) VALUES ($derivation_id, $content);

-- PREP: fts_rank_candidates
WITH candidates AS (
    SELECT json_extract(value, '$.key') AS key,
           json_extract(value, '$.deepHash') AS deep_hash
    FROM json_each($candidates)
)
SELECT c.key, f.content,
       highlight(derivation_fts, 0, $open, $close) AS highlighted
FROM derivation_fts f
JOIN derivations d ON d.id = f.rowid AND d.state = 'complete'
JOIN candidates c ON c.deep_hash = d.deep_hash
WHERE f.content MATCH $query
ORDER BY bm25(derivation_fts), c.key COLLATE BINARY;
