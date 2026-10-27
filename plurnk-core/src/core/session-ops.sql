-- {§session-scheme}: stable literal names within one workspace.

-- PREP: session_resolve_by_name
SELECT id FROM sessions WHERE workspace_id = $workspace_id AND name = $name;

-- PREP: session_name_by_id
SELECT name FROM sessions WHERE id = $session_id;

-- PREP: session_collect_loop
-- The session's live loop, otherwise its latest conclusion ({§session-scheme}).
SELECT r.name, l.sequence, l.status, l.terminal_result, l.terminated_by
FROM sessions r
JOIN loops l ON l.session_id = r.id
WHERE r.workspace_id = $workspace_id AND r.name = $name
ORDER BY CASE WHEN l.status IN (100, 102, 202) THEN 0 ELSE 1 END,
         CASE WHEN l.status IN (100, 102, 202) THEN l.sequence END DESC,
         CASE WHEN l.status NOT IN (100, 102, 202) THEN l.terminated_at END DESC,
         l.id DESC
LIMIT 1;

-- PREP: session_count_active
-- Sessions in a workspace with an unresolved loop (100 pending / 102 in-progress / 202 parked)
-- — "active" for the PLURNK_SERVICE_WORKSPACE_SESSIONS_MAX_ACTIVE ceiling (session-cap.ts).
SELECT COUNT(DISTINCT r.id) AS n FROM sessions r
JOIN loops l ON l.session_id = r.id
WHERE r.workspace_id = $workspace_id AND l.status IN (100, 102, 202);

-- PREP: session_get
SELECT workspace_id, name, origin, parent_session_id,
       model_route_id, spawn_model_route_id, effort
FROM sessions WHERE id = $id;

-- PREP: session_live_obligations
-- {§session-obligations}: the session's open non-detached streams and live children, as one row.
SELECT streams, sessions FROM session_obligations WHERE session_id = $session_id;
