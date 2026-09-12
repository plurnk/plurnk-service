-- log:/// scheme — read by (loop_sequence, turn_sequence, sequence)
-- coordinate; KILL mutates only the active projection.

-- PREP: log_read_by_coordinate
SELECT le.id, le.origin, le.op, le.scheme, le.pathname, le.status_rx, le.folded,
       le.tx, le.mimetype_tx, le.rx, le.mimetype_rx, le.attrs
FROM active_log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: log_id_by_coordinate
-- Resolve a concrete active log:/// coordinate within the worker.
SELECT le.id, le.origin, le.op, le.attrs, le.tx FROM active_log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND l.sequence = $loop_seq
  AND t.sequence = $turn_seq
  AND le.sequence = $sequence
  AND ($max_id IS NULL OR le.id <= $max_id);

-- PREP: log_match_coordinates
-- Return the literal-prefix candidate superset in the durable three-part
-- coordinate tree. TypeScript appends the canonical projected OP and applies
-- the authoritative shell-glob match.
SELECT le.id, (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate,
       le.origin, le.op, le.attrs, le.tx
FROM active_log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($max_id IS NULL OR le.id <= $max_id)
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
    le.folded,
    CASE WHEN json_valid(le.rx) THEN (json_type(le.rx, '$.nativeContentHash') = 'text'
        AND ((SELECT packet FROM turns WHERE id = $turn_id) IS NULL OR EXISTS (
            SELECT 1 FROM json_each((SELECT packet FROM turns WHERE id = $turn_id), '$.attachments') part
            WHERE json_extract(part.value, '$.coordinate') = (l.sequence || '/' || t.sequence || '/' || le.sequence)
        ))) ELSE 0 END AS native_active
FROM active_log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE le.id IN (SELECT value FROM json_each($ids))
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: log_set_folded_by_id
UPDATE log_entry_projections SET folded = $folded
WHERE log_entry_id = $id AND active = 1 AND json(folded) != json($folded)
RETURNING log_entry_id AS id;

-- PREP: log_apply_projection_plan
-- {§log-curation-direct}: a direct core-scheme curation lands its whole plan or none of it. Every
-- target's precondition is counted once, before any row changes; one stale target means zero rows.
-- The same collision-checked transition as the dispatcher's atomic curation event, without an op row.
UPDATE log_entry_projections
SET active = json_extract(plan.value, '$.activeAfter'),
    folded = json_extract(plan.value, '$.foldedAfter')
FROM json_each($targets) AS plan
WHERE log_entry_projections.log_entry_id = json_extract(plan.value, '$.id')
  AND (
      SELECT COUNT(*) FROM json_each($targets) AS t
      JOIN log_entry_projections p ON p.log_entry_id = json_extract(t.value, '$.id')
       AND p.active = json_extract(t.value, '$.activeBefore')
       AND json(p.folded) = json(json_extract(t.value, '$.foldedBefore'))
  ) = json_array_length($targets)
RETURNING log_entry_id AS id;

-- PREP: log_find_candidates
-- {§find-source-agnostic} ÷ {§log-coordinate-hierarchy} — the worker's log rows as FIND candidates,
-- three-part-coordinate-prefix-scoped (the same candidate semantics log_match_coordinates curates by), each with the
-- fields Log's rx projection renders (FIND must match exactly what READ shows). Coordinate-ordered.
SELECT
    (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate,
    le.origin, le.op, le.tx, le.mimetype_tx, le.rx, le.mimetype_rx, le.weight, le.deep_hash, le.attrs, le.folded
FROM active_log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id
  AND ($max_id IS NULL OR le.id <= $max_id)
  AND ($scope_prefix IS NULL OR substr(
      (l.sequence || '/' || t.sequence || '/' || le.sequence),
      1,
      length($scope_prefix)
  ) = $scope_prefix)
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
    d.disposition AS deep_disposition,
    d.reason AS deep_reason,
    le.attrs, le.folded
FROM active_log_entries le
LEFT JOIN derivations d ON d.deep_hash = le.deep_hash
JOIN workers w ON w.id = le.worker_id
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE w.workspace_id = $workspace_id
ORDER BY le.id;

-- PREP: log_set_deep_hash
UPDATE log_entries SET deep_hash = $deep_hash
WHERE id = $log_entry_id AND EXISTS (
    SELECT 1 FROM log_entry_projections
    WHERE log_entry_id = $log_entry_id AND active = 1 AND json(folded) = json($folded)
);

-- INIT: log_entries_initialize_projection
DROP TRIGGER IF EXISTS log_entries_initialize_projection;
CREATE TRIGGER log_entries_initialize_projection
AFTER INSERT ON log_entries
BEGIN
    INSERT INTO log_entry_projections (log_entry_id, active, folded)
    VALUES (NEW.id, 1, '[]');
END;

-- INIT: log_entry_projections_invalidate_derivation
-- {§log-readable-projection} — derived artifacts describe the active body.
DROP TRIGGER IF EXISTS log_entry_projections_invalidate_derivation;
CREATE TRIGGER log_entry_projections_invalidate_derivation
AFTER UPDATE OF folded, active ON log_entry_projections
WHEN OLD.active != NEW.active OR json(OLD.folded) != json(NEW.folded)
BEGIN
    UPDATE log_entries SET deep_hash = NULL WHERE id = NEW.log_entry_id;
END;

-- INIT: log_entries_apply_curation
-- One outer INSERT owns the whole landed curation event: exact selected rows,
-- their before/after projection, and the resulting current
-- state. Trigger failure rolls the operation row and all effects back together.
-- The private plan is erased before INSERT returns.
-- {§log-kill-scope} — a log KILL either retires a row whole (active 1→0, visibility untouched)
-- or folds a span of its body (active stays 1, visibility changes).
DROP TRIGGER IF EXISTS log_entries_apply_curation;
CREATE TRIGGER log_entries_apply_curation
AFTER INSERT ON log_entries
WHEN NEW.op = 'KILL'
 AND NEW.status_rx < 400
 AND NEW.scheme = 'log'
 AND json_type(NEW.attrs, '$.__plurnk_curation') = 'object'
BEGIN
    SELECT CASE WHEN
        COALESCE(json_type(NEW.attrs, '$.__plurnk_curation.targets'), '') != 'array'
        OR json_array_length(NEW.attrs, '$.__plurnk_curation.targets') = 0
        OR EXISTS (
            SELECT 1
            FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
            WHERE selected.type != 'object'
               OR COALESCE(json_type(selected.value, '$.id'), '') != 'integer'
               OR json_extract(selected.value, '$.id') <= 0
               OR COALESCE(json_type(selected.value, '$.activeBefore'), '') != 'integer'
               OR json_extract(selected.value, '$.activeBefore') NOT IN (0, 1)
               OR COALESCE(json_type(selected.value, '$.activeAfter'), '') != 'integer'
               OR json_extract(selected.value, '$.activeAfter') NOT IN (0, 1)
               OR COALESCE(json_type(selected.value, '$.foldedBefore'), '') != 'array'
               OR COALESCE(json_type(selected.value, '$.foldedAfter'), '') != 'array'
               OR EXISTS (
                   SELECT 1 FROM json_each(selected.value) field
                   WHERE field.key NOT IN ('id', 'activeBefore', 'activeAfter', 'foldedBefore', 'foldedAfter')
               )
               OR EXISTS (
                   SELECT 1
                   FROM (
                       SELECT 'before' AS side, range.key, range.value, range.type
                       FROM json_each(json_extract(selected.value, '$.foldedBefore')) range
                       UNION ALL
                       SELECT 'after' AS side, range.key, range.value, range.type
                       FROM json_each(json_extract(selected.value, '$.foldedAfter')) range
                   ) range
                   WHERE range.type != 'array'
                      OR json_array_length(range.value) != 2
                      OR COALESCE(json_type(range.value, '$[0]'), '') != 'integer'
                      OR COALESCE(json_type(range.value, '$[1]'), '') != 'integer'
                      OR json_extract(range.value, '$[0]') < 1
                      OR (
                          json_extract(range.value, '$[1]') != -1
                          AND json_extract(range.value, '$[1]') < json_extract(range.value, '$[0]')
                      )
                      OR EXISTS (
                          SELECT 1
                          FROM json_each(
                              CASE range.side
                                  WHEN 'before' THEN json_extract(selected.value, '$.foldedBefore')
                                  ELSE json_extract(selected.value, '$.foldedAfter')
                              END
                          ) previous
                          WHERE previous.key = range.key - 1
                            AND (
                                json_extract(previous.value, '$[1]') = -1
                                OR json_extract(range.value, '$[0]') <= json_extract(previous.value, '$[1]') + 1
                            )
                      )
               )
        )
        OR (
            SELECT COUNT(*) FROM json_each(NEW.attrs, '$.__plurnk_curation.targets')
        ) != (
            SELECT COUNT(DISTINCT json_extract(value, '$.id'))
            FROM json_each(NEW.attrs, '$.__plurnk_curation.targets')
        )
        OR EXISTS (
            SELECT 1
            FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
            LEFT JOIN log_entries target ON target.id = json_extract(selected.value, '$.id')
            LEFT JOIN log_entry_projections projection ON projection.log_entry_id = target.id
            WHERE target.id IS NULL
               OR projection.log_entry_id IS NULL
               OR target.worker_id != NEW.worker_id
               OR target.id = NEW.id
               OR projection.active != json_extract(selected.value, '$.activeBefore')
               OR json(projection.folded) != json(json_extract(selected.value, '$.foldedBefore'))
               OR NOT (
                   json_extract(selected.value, '$.activeBefore') = 1
                   AND (
                       json_extract(selected.value, '$.activeAfter') = 1
                       OR json(json_extract(selected.value, '$.foldedBefore')) = json(json_extract(selected.value, '$.foldedAfter'))
                   )
               )
        )
    THEN RAISE(ABORT, 'invalid private log curation payload') END;

    INSERT INTO log_curation_effects (
        operation_log_entry_id,
        target_log_entry_id,
        active_before,
        active_after,
        folded_before,
        folded_after
    )
    SELECT
        NEW.id,
        target.id,
        json_extract(selected.value, '$.activeBefore'),
        json_extract(selected.value, '$.activeAfter'),
        json_extract(selected.value, '$.foldedBefore'),
        json_extract(selected.value, '$.foldedAfter')
    FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
    JOIN log_entries target ON target.id = json_extract(selected.value, '$.id');

    UPDATE log_entry_projections
    SET active = (
        SELECT json_extract(selected.value, '$.activeAfter')
        FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
        WHERE json_extract(selected.value, '$.id') = log_entry_projections.log_entry_id
    ),
        folded = (
        SELECT json_extract(selected.value, '$.foldedAfter')
        FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
        WHERE json_extract(selected.value, '$.id') = log_entry_projections.log_entry_id
    )
    WHERE log_entry_id IN (
        SELECT json_extract(value, '$.id')
        FROM json_each(NEW.attrs, '$.__plurnk_curation.targets')
    );

    UPDATE log_entries
    SET attrs = json_remove(attrs, '$.__plurnk_curation')
    WHERE id = NEW.id;
END;
