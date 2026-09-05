-- PREP: reasoning_call_coordinate
SELECT '/' || l.sequence || '/' || t.sequence || '/' || c.sequence AS pathname
FROM inference_calls c JOIN turns t ON t.id = c.turn_id JOIN loops l ON l.id = t.loop_id
WHERE c.id = $model_call_id AND c.turn_id = $turn_id AND c.kind = 'emission';

-- PREP: reasoning_initial_reads
-- The most recent model turn's resources are initially observed once. Durable
-- READ history, not mutable curation state, owns whether delivery happened.
WITH latest AS (
    SELECT '/' || l.sequence || '/' || t.sequence || '/' AS prefix
    FROM turns t JOIN loops l ON l.id = t.loop_id
    WHERE l.worker_id = $worker_id AND t.producer = 'model' AND t.completed_at IS NOT NULL
    ORDER BY l.sequence DESC, t.sequence DESC LIMIT 1
)
SELECT e.pathname
FROM entries e JOIN latest ON substr(e.pathname, 1, length(latest.prefix)) = latest.prefix
WHERE e.owner_id = $worker_id AND e.scheme = 'reasoning' AND e.authority = ''
  AND NOT EXISTS (
      SELECT 1 FROM log_entries le WHERE le.worker_id = $worker_id
        AND le.op = 'READ' AND le.origin = '_plurnk'
        AND le.ambient_event_id IS NULL
        AND le.scheme = 'reasoning' AND le.pathname = e.pathname
  )
ORDER BY e.id;
