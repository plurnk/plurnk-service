-- log:/// scheme — read by (loop_sequence, turn_sequence, sequence)
-- coordinate; open/fold toggle the `expanded` flag on the addressed row.

-- PREP: log_read_by_coordinate
SELECT le.op, le.scheme, le.pathname, le.status_rx, le.rx, le.mimetype_rx
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.run_id = $run_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: log_id_by_coordinate
-- Resolve a concrete log:/// coordinate to its row id within the run (shared by
-- OPEN/FOLD's flip and KILL's erase — one resolution, two actions).
SELECT le.id FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.run_id = $run_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

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

-- PREP: log_delete_by_id
-- KILL erases a log item (plurnk.md:36, :98) — the model's DB-storage curation lever,
-- the only way to shed accumulated log rows in a long session (FOLD only collapses the
-- render). A hard delete: the row is gone, freeing storage; the derived errors pointer
-- for an `op='error'` row vanishes with it.
DELETE FROM log_entries WHERE id = $id;
