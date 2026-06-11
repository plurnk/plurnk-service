-- log:// scheme — read by (loop_sequence, turn_sequence, sequence)
-- coordinate; open/fold toggle the `indexed` flag on the addressed row.

-- PREP: log_read_by_coordinate
SELECT le.op, le.scheme, le.pathname, le.status_rx, le.rx, le.mimetype_rx
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.run_id = $run_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: log_set_indexed
-- Set indexed flag on the log entry at this coordinate within the run.
UPDATE log_entries
SET indexed = $indexed
WHERE id = (
    SELECT le.id FROM log_entries le
    JOIN turns t ON t.id = le.turn_id
    JOIN loops l ON l.id = t.loop_id
    WHERE l.run_id = $run_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence
)
RETURNING id;
