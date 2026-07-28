-- log:/// scheme — read by (loop_sequence, turn_sequence, sequence)
-- coordinate; open/fold toggle the `expanded` flag on the addressed row.

-- PREP: log_read_by_coordinate
SELECT le.op, le.scheme, le.pathname, le.status_rx, le.rx, le.mimetype_rx
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: log_id_by_coordinate
-- Resolve a concrete log:/// coordinate to its row id within the worker (shared by
-- OPEN/FOLD's flip and KILL's erase — one resolution, two actions).
SELECT le.id FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: log_match_coordinates
-- Return the literal-prefix candidate superset for a log path-glob. TypeScript
-- applies the authoritative shell-glob match so `*` remains segment-local and
-- `**` crosses coordinate segments.
SELECT le.id, (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op) AS coordinate
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($scope_prefix IS NULL OR substr(
      (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op),
      1,
      length($scope_prefix)
  ) = $scope_prefix)
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: log_set_expanded_by_id
UPDATE log_entries SET expanded = $expanded WHERE id = $id;

-- PREP: log_delete_by_id
-- KILL erases a log item (plurnk.md:36, :98) — the model's DB-storage curation lever,
-- the only way to shed accumulated log rows in a long workspace (FOLD only collapses the
-- render). A hard delete: the row is gone, freeing storage; the derived errors pointer
-- for an `op='error'` row vanishes with it.
DELETE FROM log_entries WHERE id = $id;

-- PREP: log_find_candidates
-- §find-source-agnostic ÷ §log-coordinate-hierarchy — the worker's log rows as FIND candidates,
-- coordinate-prefix-scoped (the same candidate semantics log_match_coordinates curates by), each with the
-- fields Log's rx projection renders (FIND must match exactly what READ shows). Coordinate-ordered.
SELECT
    (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op) AS coordinate,
    le.op, le.rx, le.mimetype_rx, le.tokens, le.deep_hash
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($scope_prefix IS NULL OR substr(
      (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op),
      1,
      length($scope_prefix)
  ) = $scope_prefix)
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: log_write_tag
-- §log-region-tagging — FOLD is the log's write-op (EDIT can't reach engine-written rows). FOLD[tag]
-- stamps a tag on the folded rows, additively (§edit-tags-additive) — re-tagging is a no-op.
INSERT OR IGNORE INTO log_tags (log_entry_id, tag) VALUES ($log_entry_id, $tag);

-- PREP: log_match_coordinates_tagged
-- §log-region-tagging — OPEN[tag]'s resolution: log_match_coordinates PLUS an ALL-tags AND filter
-- (§find-tag-filter-and-semantics), so OPEN[tag] recalls only rows carrying EVERY listed tag. A
-- targetless OPEN[tag] rides glob '*' (the whole run).
SELECT le.id, (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op) AS coordinate
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($scope_prefix IS NULL OR substr(
      (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op),
      1,
      length($scope_prefix)
  ) = $scope_prefix)
  AND le.id IN (
      SELECT log_entry_id FROM log_tags
      WHERE tag IN (SELECT value FROM json_each($tags))
      GROUP BY log_entry_id
      HAVING COUNT(DISTINCT tag) = json_array_length($tags)
  )
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: log_find_candidates_tagged
-- §log-region-tagging — FIND[tag](log): log_find_candidates PLUS the same ALL-tags AND filter.
SELECT
    (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op) AS coordinate,
    le.op, le.rx, le.mimetype_rx, le.tokens, le.deep_hash
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($scope_prefix IS NULL OR substr(
      (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op),
      1,
      length($scope_prefix)
  ) = $scope_prefix)
  AND le.id IN (
      SELECT log_entry_id FROM log_tags
      WHERE tag IN (SELECT value FROM json_each($tags))
      GROUP BY log_entry_id
      HAVING COUNT(DISTINCT tag) = json_array_length($tags)
  )
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: log_derivation_rows
-- Every log row in a workspace, with its stable model-facing coordinate and
-- current derivation attachment. The TypeScript projection resolves rx to the
-- exact body/mimetype READ and FIND expose before hashing or deriving it.
SELECT
    le.id,
    (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op) AS coordinate,
    le.rx,
    le.mimetype_rx,
    le.deep_hash
FROM log_entries le
JOIN workers w ON w.id = le.worker_id
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE w.workspace_id = $workspace_id
ORDER BY le.id;

-- PREP: log_set_deep_hash
UPDATE log_entries SET deep_hash = $deep_hash WHERE id = $log_entry_id;
