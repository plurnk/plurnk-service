-- PREP: reasoning_initial_reads
-- The most recent model turn's resources are initially observed once. Durable
-- READ history, not mutable curation state, owns whether delivery happened.
WITH latest AS (
    SELECT t.id, '/' || l.sequence || '/' || t.sequence AS pathname
    FROM turns t JOIN loops l ON l.id = t.loop_id
    WHERE l.worker_id = $worker_id AND t.producer = 'model' AND t.completed_at IS NOT NULL
    ORDER BY l.sequence DESC, t.sequence DESC LIMIT 1
)
SELECT latest.pathname
FROM latest JOIN turn_sources s ON s.turn_id = latest.id AND s.kind = 'reasoning'
WHERE NOT EXISTS (
      SELECT 1 FROM log_entries le WHERE le.worker_id = $worker_id
        AND le.op = 'READ' AND le.origin = '_plurnk'
        AND le.ambient_event_id IS NULL
        AND le.scheme = 'reasoning' AND le.pathname = latest.pathname
  );
