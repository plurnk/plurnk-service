-- CoreSeam readLog query. SPEC {§methods-log-read}.
-- Static query with IS-NULL guards on optional filters. The loops/turns joins
-- resolve the DISPLAY coordinate (loop_seq/turn_seq/op-sequence) so a client can
-- target one entry by its `L/T/S` coordinate instead of
-- fetching a worker and matching client-side. INNER JOINs are safe: log_entries
-- carries worker_id/loop_id/turn_id NOT NULL, so no row is dropped; the coordinate
-- guards are inert when their param is NULL (identical to the id-only filters).

-- PREP: log_read_recent_ids
SELECT le.id FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE le.worker_id = $worker_id
  AND ($loop_id IS NULL OR le.loop_id = $loop_id)
  AND ($turn_id IS NULL OR le.turn_id = $turn_id)
  AND ($since_id IS NULL OR le.id > $since_id)
  AND ($loop_seq IS NULL OR l.sequence = $loop_seq)
  AND ($turn_seq IS NULL OR t.sequence = $turn_seq)
  AND ($sequence IS NULL OR le.sequence = $sequence)
ORDER BY le.at DESC
LIMIT $limit;
