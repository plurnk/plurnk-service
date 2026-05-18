-- log:// scheme read by (loop_sequence, turn_sequence, action_index) coordinate.

-- PREP: log_read_by_coordinate
SELECT le.op, le.target_scheme, le.target_pathname, le.status_rx, le.rx, le.mimetype_rx
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.run_id = $run_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.action_index = $action_index;
