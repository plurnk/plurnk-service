-- Durable pending client interactions. {§client-interactions}

-- PREP: client_interaction_insert
-- Insert only when all supplied coordinates describe one existing operation.
INSERT INTO client_interactions (worker_id, loop_id, turn_id, request)
SELECT $worker_id, $loop_id, $turn_id, $request
WHERE EXISTS (
    SELECT 1
    FROM turns t
    JOIN loops l ON l.id = t.loop_id
    JOIN workers w ON w.id = l.worker_id
    WHERE t.id = $turn_id
      AND l.id = $loop_id
      AND l.worker_id = $worker_id
      AND w.workspace_id = $workspace_id
)
RETURNING id;

-- PREP: client_interaction_list
SELECT i.id AS interactionId,
       w.workspace_id AS workspaceId,
       i.worker_id AS workerId,
       i.loop_id AS loopId,
       i.turn_id AS turnId,
       i.request
FROM client_interactions i
JOIN workers w ON w.id = i.worker_id
WHERE w.workspace_id = $workspace_id
ORDER BY i.id;

-- PREP: client_interaction_delete
DELETE FROM client_interactions
WHERE id = $interaction_id
RETURNING id;
