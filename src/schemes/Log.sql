-- log:/// scheme — read by (loop_sequence, turn_sequence, sequence)
-- coordinate; open/fold toggle the `expanded` flag on the addressed row.

-- PREP: log_read_by_coordinate
SELECT le.op, le.scheme, le.pathname, le.status_rx, le.rx, le.mimetype_rx
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.run_id = $run_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: log_set_expanded
-- Set expanded flag on the log entry at this coordinate within the run.
UPDATE log_entries
SET expanded = $expanded
WHERE id = (
    SELECT le.id FROM log_entries le
    JOIN turns t ON t.id = le.turn_id
    JOIN loops l ON l.id = t.loop_id
    WHERE l.run_id = $run_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence
)
RETURNING id;

-- PREP: log_match_coordinates
-- Resolve a log:/// path-glob to the matching rows within the run, coordinate-ordered.
-- The rendered `loop/turn/seq/op` is GLOB-matched against the target (SQLite GLOB:
-- `*` spans any chars incl '/', so `**/READ` ≈ `*/READ`). Drives glob/paginated
-- OPEN/FOLD — the model's primary log-curation move, e.g. FOLD(log:///**/READ)<1>.
SELECT le.id
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.run_id = $run_id
  AND (l.sequence || '/' || t.sequence || '/' || le.sequence || '/' || le.op) GLOB $glob
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: log_set_expanded_by_id
UPDATE log_entries SET expanded = $expanded WHERE id = $id;
