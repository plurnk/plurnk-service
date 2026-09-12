-- {§worker-authority-carving}: stable literal names within one workspace.

-- PREP: worker_resolve_by_name
SELECT id FROM workers WHERE workspace_id = $workspace_id AND name = $name;

-- PREP: worker_name_by_id
SELECT name FROM workers WHERE id = $worker_id;

-- PREP: worker_deliverable_by_name
-- The named worker, with its live loop or latest-settled terminal result — the
-- deliverable a sister COLLECTS by READing worker://<name> ({§worker-scheme-collect}, the pull side of
-- the same deliverable the push delta carries). Non-terminal means the worker has not delivered yet
-- (READ steers to 202).
-- terminated_by names an external cancellation so COLLECT renders its marker.
SELECT r.id AS worker_id, l.id, l.status, l.terminal_result, l.terminated_by,
       l.scheduled_at, l.repeat_interval_ms, l.recurrence_root_loop_id
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
