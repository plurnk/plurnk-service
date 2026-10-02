-- {§graph-relations} symbol_defs/refs population + &< / &> / &
-- resolution. Populated delete-then-insert per readable derivation by SearchIndex;
-- queried by the `graph` dialect via EntryGraph. Traversal is kind-agnostic
-- (every ref is an edge; `kind` is edge metadata, never filtered here). 1-hop —
-- the grammar's `&<sym` surface is single-hop; WITH RECURSIVE the day it grows one.

-- PREP: graph_delete_defs
DELETE FROM symbol_defs WHERE derivation_id = $derivation_id;

-- PREP: graph_delete_refs
DELETE FROM symbol_refs WHERE derivation_id = $derivation_id;

-- PREP: graph_insert_defs_bulk
INSERT INTO symbol_defs (derivation_id, name, kind, container, line, column, end_line, end_column)
SELECT $derivation_id,
       json_extract(value, '$.name'), json_extract(value, '$.kind'),
       json_extract(value, '$.container'), json_extract(value, '$.line'),
       json_extract(value, '$.column'), json_extract(value, '$.endLine'), json_extract(value, '$.endColumn')
FROM json_each($rows);

-- PREP: graph_insert_refs_bulk
INSERT INTO symbol_refs (derivation_id, name, kind, container, line, column, end_line, end_column)
SELECT $derivation_id,
       json_extract(value, '$.name'), json_extract(value, '$.kind'),
       json_extract(value, '$.container'), json_extract(value, '$.line'),
       json_extract(value, '$.column'), json_extract(value, '$.endLine'), json_extract(value, '$.endColumn')
FROM json_each($rows);

-- PREP: derivation_get
SELECT id, state, disposition, reason FROM derivations WHERE deep_hash = $deep_hash;

-- PREP: derivation_create
INSERT INTO derivations (deep_hash, state)
VALUES ($deep_hash, 'building')
RETURNING id, state;

-- PREP: derivation_complete
UPDATE derivations
SET state = 'complete', disposition = $disposition, reason = $reason,
    parse_issues = $parse_issues, summary = $summary
WHERE id = $derivation_id;

-- PREP: graph_match_candidates
-- Coordinates, source text, and index completeness share one SQLite snapshot.
WITH universe AS MATERIALIZED (
    SELECT json_extract(value, '$.deepHash') AS deep_hash
    FROM json_each($universe)
),
candidates AS MATERIALIZED (
    SELECT json_extract(value, '$.key') AS key,
           json_extract(value, '$.deepHash') AS deep_hash
    FROM json_each($candidates)
),
sources AS (
    SELECT DISTINCT d.derivation_id,
           CASE WHEN d.container IS NULL THEN $name ELSE d.container || '.' || $name END AS qualified
    FROM symbol_defs d
    JOIN derivations x ON x.id = d.derivation_id
    JOIN universe u ON u.deep_hash = x.deep_hash
    WHERE d.name = $name
),
targets AS (
    SELECT DISTINCT r.name
    FROM symbol_refs r
    JOIN sources s ON s.derivation_id = r.derivation_id AND r.container IS s.qualified
),
hits AS (
    SELECT d.derivation_id, d.line, d.column, COALESCE(d.end_line, d.line) AS end_line, d.end_column
    FROM symbol_defs d
    WHERE ($direction = '' AND d.name = $name)
       OR ($direction = '>' AND d.name IN (SELECT name FROM targets))
    UNION
    SELECT r.derivation_id, r.line, r.column, r.end_line, r.end_column
    FROM symbol_refs r
    WHERE $direction = '<' AND r.name = $name
)
SELECT DISTINCT c.key, d.state, t.content, h.line, h.column, h.end_line, h.end_column,
    $direction != '>' OR NOT EXISTS (
        SELECT 1 FROM universe u LEFT JOIN derivations x ON x.deep_hash = u.deep_hash
        WHERE x.state IS NOT 'complete'
    ) AS universe_ready
FROM candidates c
LEFT JOIN derivations d ON d.deep_hash = c.deep_hash
LEFT JOIN contents t ON t.id = d.content_id
LEFT JOIN hits h ON h.derivation_id = d.id AND d.state = 'complete'
ORDER BY c.key COLLATE BINARY, h.line, h.column, h.end_line, h.end_column;
