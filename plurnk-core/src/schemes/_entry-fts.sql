-- {§find-fulltext-selection} Native FTS5 query and ranking over visible candidates.

-- PREP: fts_intern
-- {§content-store}: the indexed text joins the content store (a no-op when a channel already holds it).
INSERT INTO contents (hash, content) VALUES ($hash, $content)
ON CONFLICT (hash) DO NOTHING;

-- PREP: fts_attach
-- One statement re-points the artifact at its text; derivations_fts_follow moves the index with it.
UPDATE derivations
SET content_id = (SELECT id FROM contents WHERE hash = $hash)
WHERE id = $derivation_id;

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

-- INIT: derivations_delete_fts
-- {§retention-policy}: the full-text row is the derivation's shadow (rowid = derivation id) and
-- leaves with it on every delete path, so no collector has to remember it. External content is
-- forgotten only when handed the exact text it indexed, which the store still holds here.
DROP TRIGGER IF EXISTS derivations_delete_fts;
CREATE TRIGGER derivations_delete_fts
AFTER DELETE ON derivations
BEGIN
    INSERT INTO derivation_fts (derivation_fts, rowid, content)
    SELECT 'delete', OLD.id, content FROM contents WHERE id = OLD.content_id;
END;

-- INIT: derivations_fts_follow
DROP TRIGGER IF EXISTS derivations_fts_follow;
CREATE TRIGGER derivations_fts_follow
AFTER UPDATE OF content_id ON derivations
WHEN OLD.content_id IS NOT NEW.content_id
BEGIN
    INSERT INTO derivation_fts (derivation_fts, rowid, content)
    SELECT 'delete', OLD.id, content FROM contents WHERE id = OLD.content_id;
    INSERT INTO derivation_fts (rowid, content)
    SELECT NEW.id, content FROM contents WHERE id = NEW.content_id;
END;
