-- log.read RPC query. SPEC §13.5.
-- Static query with IS-NULL guards on optional filters.

-- PREP: log_read_recent_ids
SELECT id FROM log_entries
WHERE run_id = $run_id
  AND ($loop_id IS NULL OR loop_id = $loop_id)
  AND ($turn_id IS NULL OR turn_id = $turn_id)
  AND ($since_id IS NULL OR id > $since_id)
ORDER BY at DESC
LIMIT $limit;
