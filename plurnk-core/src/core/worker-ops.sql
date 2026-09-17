-- {§worker-authority-carving}: stable literal names within one workspace.

-- PREP: worker_resolve_by_name
SELECT id FROM workers WHERE workspace_id = $workspace_id AND name = $name;

-- PREP: worker_name_by_id
SELECT name FROM workers WHERE id = $worker_id;

-- PREP: worker_collect_loop
-- The worker's live loop, otherwise its latest conclusion ({§worker-scheme-collect}).
SELECT r.name, l.sequence, l.status, l.terminal_result, l.terminated_by
FROM workers r
JOIN loops l ON l.worker_id = r.id
WHERE r.workspace_id = $workspace_id AND r.name = $name
ORDER BY CASE WHEN l.status IN (100, 102, 202) THEN 0 ELSE 1 END,
         CASE WHEN l.status IN (100, 102, 202) THEN l.sequence END DESC,
         CASE WHEN l.status NOT IN (100, 102, 202) THEN l.terminated_at END DESC,
         l.id DESC
LIMIT 1;

-- PREP: worker_count_active
-- Workers in a workspace with an unresolved loop (100 pending / 102 in-progress / 202 parked)
-- — "active" for the PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE ceiling (worker-cap.ts).
SELECT COUNT(DISTINCT r.id) AS n FROM workers r
JOIN loops l ON l.worker_id = r.id
WHERE r.workspace_id = $workspace_id AND l.status IN (100, 102, 202);

-- PREP: worker_get
SELECT workspace_id, name, origin, parent_worker_id,
       model_route_id, spawn_model_route_id, reasoning_policy
FROM workers WHERE id = $id;

-- PREP: worker_live_obligations
-- {§worker-obligations}: the worker's open non-detached streams and live children, as one row.
SELECT streams, workers FROM worker_obligations WHERE worker_id = $worker_id;
