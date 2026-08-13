-- {§graph-relations} symbol_defs/refs population + @< / @> / @
-- resolution. Populated delete-then-insert per readable derivation by SearchIndex;
-- queried by the FIND `graph` dialect via EntryGraph. Traversal is kind-agnostic
-- (every ref is an edge; `kind` is edge metadata, never filtered here). 1-hop —
-- the grammar's `@<sym` surface is single-hop; WITH RECURSIVE the day it grows one.

-- PREP: graph_delete_defs
DELETE FROM symbol_defs WHERE derivation_id = $derivation_id;

-- PREP: graph_delete_refs
DELETE FROM symbol_refs WHERE derivation_id = $derivation_id;

-- PREP: graph_insert_def
INSERT INTO symbol_defs (derivation_id, name, kind, container, line, end_line)
VALUES ($derivation_id, $name, $kind, $container, $line, $end_line);

-- PREP: graph_insert_ref
INSERT INTO symbol_refs (derivation_id, name, kind, container, line, col)
VALUES ($derivation_id, $name, $kind, $container, $line, $col);

-- PREP: graph_insert_defs_bulk
INSERT INTO symbol_defs (derivation_id, name, kind, container, line, end_line)
SELECT $derivation_id,
       json_extract(value, '$.name'), json_extract(value, '$.kind'),
       json_extract(value, '$.container'), json_extract(value, '$.line'),
       json_extract(value, '$.endLine')
FROM json_each($rows);

-- PREP: graph_insert_refs_bulk
INSERT INTO symbol_refs (derivation_id, name, kind, container, line, col)
SELECT $derivation_id,
       json_extract(value, '$.name'), json_extract(value, '$.kind'),
       json_extract(value, '$.container'), json_extract(value, '$.line'),
       json_extract(value, '$.column')
FROM json_each($rows);

-- PREP: derivation_get
SELECT id, state FROM derivations WHERE deep_hash = $deep_hash;

-- PREP: derivation_create
INSERT INTO derivations (deep_hash, state)
VALUES ($deep_hash, 'building')
RETURNING id, state;

-- PREP: derivation_complete
UPDATE derivations
SET state = 'complete', disposition = $disposition, reason = $reason, parse_issues = $parse_issues
WHERE id = $derivation_id;

-- PREP: graph_referrers_candidates
-- @<sym — candidate resources that reference sym, with each reference's line.
-- {§matcher-selection-signal}
WITH candidates AS (
    SELECT json_extract(value, '$.key') AS key,
           json_extract(value, '$.deepHash') AS deep_hash
    FROM json_each($candidates)
)
SELECT DISTINCT c.key, r.line AS line, r.line AS end_line
FROM symbol_refs r
JOIN derivations d ON d.id = r.derivation_id
JOIN candidates c ON c.deep_hash = d.deep_hash
WHERE r.name = $name
ORDER BY c.key, r.line;

-- PREP: graph_defs_candidates
-- Resolve a name → the defining candidate keys + def span. Serves
-- @>'s target resolution and @'s neighborhood def lookup. end_line falls back to line
-- when a definition has no end. {§matcher-selection-signal}
WITH candidates AS (
    SELECT json_extract(value, '$.key') AS key,
           json_extract(value, '$.deepHash') AS deep_hash
    FROM json_each($candidates)
)
SELECT DISTINCT c.key, d.line AS line, COALESCE(d.end_line, d.line) AS end_line
FROM symbol_defs d
JOIN derivations x ON x.id = d.derivation_id
JOIN candidates c ON c.deep_hash = x.deep_hash
WHERE d.name = $name
ORDER BY c.key, d.line;

-- PREP: graph_resolve_def_candidates
-- sym → its definition artifacts in the caller's relationship universe.
WITH candidates AS (
    SELECT json_extract(value, '$.deepHash') AS deep_hash
    FROM json_each($candidates)
)
SELECT DISTINCT d.derivation_id, d.container
FROM symbol_defs d
JOIN derivations x ON x.id = d.derivation_id
JOIN candidates c ON c.deep_hash = x.deep_hash
WHERE d.name = $name;

-- PREP: graph_refs_from_source
-- @>sym step — the target names referenced by sym's definition, whose own
-- reference rows key on the source definition's fully qualified container.
-- {§graph-relations}
SELECT DISTINCT name FROM symbol_refs
WHERE derivation_id = $derivation_id AND container IS $container;

-- PREP: graph_set_deep_hash
-- Stamp the body-content hash at the moment an entry's deep channels were
-- (re)derived. The next manifest-add pass skips the entry while the hash holds.
UPDATE entries SET deep_hash = $deep_hash WHERE id = $entry_id;
