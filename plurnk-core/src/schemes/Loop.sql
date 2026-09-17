-- PREP: loop_resource_read
SELECT w.name, l.sequence, l.status, l.terminal_result, l.terminated_by
FROM workers w JOIN loops l ON l.worker_id = w.id
WHERE w.workspace_id = $workspace_id AND w.name = $name AND l.sequence = $sequence;

-- PREP: loop_resource_candidates
SELECT w.name, l.sequence, l.status, l.terminal_result, l.terminated_by
FROM workers w JOIN loops l ON l.worker_id = w.id
WHERE w.workspace_id = $workspace_id ORDER BY w.id, l.sequence;
