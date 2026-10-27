-- Automatic session allocation. SPEC {§execution-output-identity}.

-- PREP: session_name_claim
-- Claiming the literal and creating its session are one SQLite write statement. Every session it mints is a
-- model's ({§machine-processes}).
INSERT INTO sessions (
    workspace_id, name, parent_session_id, origin, owner,
    ambient_event_cursor, fork_event_boundary,
    model_route_id, spawn_model_route_id, effort
)
SELECT $workspace_id, $name, $parent_session_id, 'model', $owner,
       CASE WHEN $fork_snapshot = 1 THEN (
           SELECT ambient_event_cursor FROM sessions WHERE id = $parent_session_id
       ) ELSE NULL END,
       CASE WHEN $fork_snapshot = 1 THEN COALESCE((
           SELECT MAX(ae.id) FROM ambient_events ae WHERE ae.workspace_id = $workspace_id
       ), 0) ELSE NULL END,
       -- {§machine-processes}: a branch copies durable generation policy by value, then diverges.
       CASE WHEN $fork_snapshot = 1 THEN (SELECT model_route_id FROM sessions WHERE id = $parent_session_id) END,
       CASE WHEN $fork_snapshot = 1 THEN (SELECT spawn_model_route_id FROM sessions WHERE id = $parent_session_id) END,
       CASE WHEN $fork_snapshot = 1 THEN (SELECT effort FROM sessions WHERE id = $parent_session_id) END
WHERE NOT EXISTS (
    SELECT 1
    FROM sessions
    WHERE workspace_id = $workspace_id AND name = $name
)
AND (
    $fork_snapshot = 0 OR EXISTS (
        SELECT 1 FROM sessions
        WHERE id = $parent_session_id AND workspace_id = $workspace_id
    )
)
RETURNING id, name;
