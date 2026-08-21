-- log:/// scheme — read by (loop_sequence, turn_sequence, sequence)
-- coordinate; OPEN/FOLD mutate canonical hidden body-line intervals.

-- PREP: log_read_by_coordinate
SELECT le.origin, le.op, le.scheme, le.pathname, le.status_rx,
       le.tx, le.mimetype_tx, le.rx, le.mimetype_rx, le.attrs
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: log_id_by_coordinate
-- Resolve a concrete log:/// coordinate to its row id within the worker (shared by
-- OPEN/FOLD's flip and KILL's erase — one resolution, two actions).
SELECT le.id, le.origin, le.op, le.attrs FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: log_match_coordinates
-- Return the literal-prefix candidate superset in the durable three-part
-- coordinate tree. TypeScript appends the canonical projected OP and applies
-- the authoritative shell-glob match.
SELECT le.id, (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate,
       le.origin, le.op, le.attrs
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($scope_prefix IS NULL OR substr(
      (l.sequence || '/' || t.sequence || '/' || le.sequence),
      1,
      length($scope_prefix)
  ) = $scope_prefix)
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: log_curation_targets
-- The exact selected set resolved above, with the canonical body inputs and
-- current visibility needed to plan one deterministic curation event.
SELECT
    le.id,
    (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate,
    le.origin,
    le.op,
    le.tx,
    le.mimetype_tx,
    le.rx,
    le.mimetype_rx,
    le.attrs,
    le.folded
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE le.id IN (SELECT value FROM json_each($ids))
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: log_set_folded_by_id
UPDATE log_entries SET folded = $folded
WHERE id = $id AND json(folded) != json($folded)
RETURNING id;

-- PREP: log_delete_by_id
-- {§turn-ops-log-curation} — permanent row deletion; the derived errors pointer for an
-- `op='error'` row vanishes with it.
DELETE FROM log_entries WHERE id = $id;

-- PREP: log_find_candidates
-- {§find-source-agnostic} ÷ {§log-coordinate-hierarchy} — the worker's log rows as FIND candidates,
-- three-part-coordinate-prefix-scoped (the same candidate semantics log_match_coordinates curates by), each with the
-- fields Log's rx projection renders (FIND must match exactly what READ shows). Coordinate-ordered.
SELECT
    (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate,
    le.origin, le.op, le.tx, le.mimetype_tx, le.rx, le.mimetype_rx, le.weight, le.deep_hash, le.attrs,
    COALESCE((
        SELECT json_group_array(ordered.tag)
        FROM (
            SELECT tag FROM log_tags WHERE log_entry_id = le.id ORDER BY tag
        ) ordered
    ), '[]') AS tags
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($scope_prefix IS NULL OR substr(
      (l.sequence || '/' || t.sequence || '/' || le.sequence),
      1,
      length($scope_prefix)
  ) = $scope_prefix)
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: log_write_tag
-- {§log-item-tags} — classification at the durable log-write seam;
-- engine policy may use the same idempotent primitive for its own classifications.
INSERT OR IGNORE INTO log_tags (log_entry_id, tag) VALUES ($log_entry_id, $tag);

-- PREP: log_remove_tag
DELETE FROM log_tags WHERE log_entry_id = $log_entry_id AND tag = $tag;

-- PREP: log_match_coordinates_tagged
-- {§log-item-tags} — OPEN/FOLD resolution with an ALL-tags AND filter. A
-- targetless tagged operation uses the whole worker log.
SELECT le.id, (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate,
       le.origin, le.op, le.attrs
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($scope_prefix IS NULL OR substr(
      (l.sequence || '/' || t.sequence || '/' || le.sequence),
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

-- PREP: log_curation_find_candidates_tagged
-- {§log-item-tags} — private matcher-bearing OPEN/FOLD candidates after the
-- same ALL-tags filter; an authored FIND signal never routes here.
SELECT
    (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate,
    le.origin, le.op, le.tx, le.mimetype_tx, le.rx, le.mimetype_rx, le.weight, le.deep_hash, le.attrs,
    COALESCE((
        SELECT json_group_array(ordered.tag)
        FROM (
            SELECT tag FROM log_tags WHERE log_entry_id = le.id ORDER BY tag
        ) ordered
    ), '[]') AS tags
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($scope_prefix IS NULL OR substr(
      (l.sequence || '/' || t.sequence || '/' || le.sequence),
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
    (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate,
    le.origin,
    le.op,
    le.tx,
    le.mimetype_tx,
    le.rx,
    le.mimetype_rx,
    le.deep_hash,
    le.attrs
FROM log_entries le
JOIN workers w ON w.id = le.worker_id
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE w.workspace_id = $workspace_id
ORDER BY le.id;

-- PREP: log_set_deep_hash
UPDATE log_entries SET deep_hash = $deep_hash WHERE id = $log_entry_id;
