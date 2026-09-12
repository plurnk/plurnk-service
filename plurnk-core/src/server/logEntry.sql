-- Log-entry hydration for wire surfacing.

-- PREP: log_entry_by_id
-- loop_seq / turn_seq are the loop+turn ordinals (the logical coordinate clients
-- render, e.g. 01/02/03) — distinct from the loop_id/turn_id DB keys ({§methods-log-coordinate}).
SELECT le.*, l.sequence AS loop_seq, t.sequence AS turn_seq,
       CASE
           WHEN le.origin = 'model'
            AND le.op IN ('SEND', 'TASK')
            AND json_type(t.packet, '$.assistant.reasoning') = 'text'
            AND length(json_extract(t.packet, '$.assistant.reasoning')) > 0
           THEN json_extract(t.packet, '$.assistant.reasoning')
       END AS reasoning
FROM log_entries le
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE le.id = $id;

-- PREP: log_entries_recent
-- {§methods-log-read}: the newest rows a client asks for, hydrated exactly as log_entry_by_id
-- hydrates one — a page is one statement, never one statement per row.
SELECT le.*, l.sequence AS loop_seq, t.sequence AS turn_seq,
       CASE
           WHEN le.origin = 'model'
            AND le.op IN ('SEND', 'TASK')
            AND json_type(t.packet, '$.assistant.reasoning') = 'text'
            AND length(json_extract(t.packet, '$.assistant.reasoning')) > 0
           THEN json_extract(t.packet, '$.assistant.reasoning')
       END AS reasoning
FROM log_entries le
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE le.worker_id = $worker_id
  AND ($loop_id IS NULL OR le.loop_id = $loop_id)
  AND ($turn_id IS NULL OR le.turn_id = $turn_id)
  AND ($since_id IS NULL OR le.id > $since_id)
  AND ($loop_seq IS NULL OR l.sequence = $loop_seq)
  AND ($turn_seq IS NULL OR t.sequence = $turn_seq)
  AND ($sequence IS NULL OR le.sequence = $sequence)
ORDER BY le.at DESC
LIMIT $limit;
