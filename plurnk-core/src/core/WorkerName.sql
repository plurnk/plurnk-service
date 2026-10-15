-- Automatic worker allocation. SPEC {§worker-auto-name}.

-- PREP: worker_name_claim
-- Claiming the literal and creating its worker are one SQLite write statement.
INSERT INTO workers (
    workspace_id, name, parent_worker_id, origin, owner,
    ambient_event_cursor, fork_event_boundary,
    model_route_id, spawn_model_route_id, effort
)
SELECT $workspace_id, $name, $parent_worker_id, $origin, $owner,
       CASE WHEN $fork_snapshot = 1 THEN (
           SELECT ambient_event_cursor FROM workers WHERE id = $parent_worker_id
       ) ELSE NULL END,
       CASE WHEN $fork_snapshot = 1 THEN COALESCE((
           SELECT MAX(ae.id) FROM ambient_events ae WHERE ae.workspace_id = $workspace_id
       ), 0) ELSE NULL END,
       -- {§worker-fork-trigger}: a branch copies durable generation policy by value, then diverges.
       CASE WHEN $fork_snapshot = 1 THEN (SELECT model_route_id FROM workers WHERE id = $parent_worker_id) END,
       CASE WHEN $fork_snapshot = 1 THEN (SELECT spawn_model_route_id FROM workers WHERE id = $parent_worker_id) END,
       CASE WHEN $fork_snapshot = 1 THEN (SELECT effort FROM workers WHERE id = $parent_worker_id) END
WHERE NOT EXISTS (
    SELECT 1
    FROM workers
    WHERE workspace_id = $workspace_id AND name = $name
)
AND (
    $fork_snapshot = 0 OR EXISTS (
        SELECT 1 FROM workers
        WHERE id = $parent_worker_id AND workspace_id = $workspace_id
    )
)
RETURNING id, name;
