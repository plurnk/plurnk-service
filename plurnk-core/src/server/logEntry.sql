-- Log-entry hydration for wire surfacing.

-- PREP: log_entry_by_id
-- loop_seq / turn_seq are the loop+turn ordinals (the logical coordinate clients
-- render, e.g. 01/02/03) — distinct from the loop_id/turn_id DB keys ({§methods-log-coordinate}).
SELECT le.*, l.sequence AS loop_seq, t.sequence AS turn_seq
FROM log_entries le
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE le.id = $id;
