-- @graph (plurnk-service#186) — symbol_defs/refs population + @< / @> / @
-- resolution. Populated delete-then-insert per entry at EntryCrud.writeEntry;
-- queried by the FIND `graph` dialect via EntryGraph. Traversal is kind-agnostic
-- (every ref is an edge; `kind` is edge metadata, never filtered here). 1-hop —
-- the grammar's `@<sym` surface is single-hop; WITH RECURSIVE the day it grows one.

-- PREP: graph_delete_defs
DELETE FROM symbol_defs WHERE entry_id = $entry_id;

-- PREP: graph_delete_refs
DELETE FROM symbol_refs WHERE entry_id = $entry_id;

-- PREP: graph_insert_def
INSERT INTO symbol_defs (session_id, entry_id, name, kind, container, line, end_line)
VALUES ($session_id, $entry_id, $name, $kind, $container, $line, $end_line);

-- PREP: graph_insert_ref
INSERT INTO symbol_refs (session_id, entry_id, name, kind, container, line, col)
VALUES ($session_id, $entry_id, $name, $kind, $container, $line, $col);

-- PREP: graph_referrers
-- @<sym — entries (scheme-scoped) that reference sym.
SELECT DISTINCT e.pathname
FROM symbol_refs r JOIN entries e ON e.id = r.entry_id
WHERE r.session_id = $session_id AND e.scheme IS $scheme AND r.name = $name
ORDER BY e.pathname;

-- PREP: graph_def_pathnames_by_name
-- Resolve a name → the defining entries' pathnames (scheme-scoped). Serves @>'s
-- target resolution and @'s neighborhood def lookup.
SELECT DISTINCT e.pathname
FROM symbol_defs d JOIN entries e ON e.id = d.entry_id
WHERE d.session_id = $session_id AND e.scheme IS $scheme AND d.name = $name
ORDER BY e.pathname;

-- PREP: graph_resolve_def
-- sym → its def(s): (entry_id, container) to compose the qualified path for @>.
SELECT entry_id, container FROM symbol_defs
WHERE session_id = $session_id AND name = $name;

-- PREP: graph_refs_from_source
-- @>sym step — the target names sym's def references (its own ref rows, keyed
-- by the source def's full qualified path = the @> join semantics from #186).
SELECT DISTINCT name FROM symbol_refs
WHERE session_id = $session_id AND entry_id = $entry_id AND container IS $container;

-- PREP: graph_set_deep_hash
-- Stamp the body-content hash at the moment an entry's deep channels were
-- (re)derived. The next manifest-add pass skips the entry while the hash holds.
UPDATE entries SET deep_hash = $deep_hash WHERE id = $entry_id;
