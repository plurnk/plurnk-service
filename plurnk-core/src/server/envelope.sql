-- Envelope lifecycle queries. SPEC {§connection-lifecycle}.

-- PREP: envelope_insert_workspace
INSERT INTO workspaces (name, project_root, settings)
VALUES ($name, $project_root, $settings)
ON CONFLICT(name) DO NOTHING
RETURNING id, name, project_root;

-- PREP: envelope_get_workspace
SELECT id, name, project_root FROM workspaces WHERE id = $id;


-- PREP: envelope_get_workspace_by_name
-- workspace.rename collision check — workspaces.name is UNIQUE. {§machine-processes} a hidden one still holds its name.
SELECT id, hidden_at FROM workspaces WHERE name = $name;

-- PREP: envelope_set_workspace_name
-- Used by workspace.rename. The workspace name is a MUTABLE handle (vs a session's
-- immutable name, {§machine-processes}). Returns the updated row to refresh the
-- caller's ClientEnvelope copy.
UPDATE workspaces SET name = $name
WHERE id = $id
  AND NOT EXISTS (
    SELECT 1 FROM workspaces AS other
    WHERE other.name = $name AND other.id <> $id
  )
RETURNING id, name;

-- {§application-session-observation}: kind is minted lineage (fork boundary → fork, other child →
-- work, no parent → root); loop observations feed the shared lifecycle selector in TS.
-- PREP: envelope_get_session_by_id
SELECT id, name, workspace_id, created_at, origin, owner,
       parent_session_id AS parentSessionId, hidden_at,
       CASE WHEN fork_event_boundary IS NOT NULL THEN 'fork'
            WHEN parent_session_id IS NOT NULL THEN 'work'
            ELSE 'root' END AS kind,
       (SELECT json_group_array(json_object('status', l.status, 'sequence', l.sequence, 'terminatedAt', l.terminated_at))
          FROM work_loops l WHERE l.session_id = sessions.id) AS loopObservations
FROM sessions
WHERE id = $id;

-- PREP: envelope_get_session_by_name
SELECT id, name, workspace_id, created_at, origin, owner,
       parent_session_id AS parentSessionId, hidden_at,
       CASE WHEN fork_event_boundary IS NOT NULL THEN 'fork'
            WHEN parent_session_id IS NOT NULL THEN 'work'
            ELSE 'root' END AS kind,
       (SELECT json_group_array(json_object('status', l.status, 'sequence', l.sequence, 'terminatedAt', l.terminated_at))
          FROM work_loops l WHERE l.session_id = sessions.id) AS loopObservations
FROM sessions
WHERE workspace_id = $workspace_id AND name = $name;

-- PREP: envelope_list_sessions_for_workspace
-- {§machine-processes} $hidden: null lists every session, 1 only hidden ones, 0 only shown ones.
SELECT id, name, created_at, origin, owner, parent_session_id AS parentSessionId, hidden_at,
       CASE WHEN fork_event_boundary IS NOT NULL THEN 'fork'
            WHEN parent_session_id IS NOT NULL THEN 'work'
            ELSE 'root' END AS kind,
       (SELECT json_group_array(json_object('status', l.status, 'sequence', l.sequence, 'terminatedAt', l.terminated_at))
          FROM work_loops l WHERE l.session_id = sessions.id) AS loopObservations
FROM sessions
WHERE workspace_id = $workspace_id
  AND ($origin IS NULL OR origin = $origin)
  AND ($filter_parent = 0 OR parent_session_id IS $parent_session_id)
  AND ($hidden IS NULL OR (hidden_at IS NOT NULL) = $hidden)
ORDER BY created_at DESC;

-- PREP: workspace_capability_policy_update
-- {§workspace-capability-policy}: one atomic field replacement preserves other settings.
UPDATE workspaces SET settings = json_set(settings, '$.capabilities', json($policy))
WHERE id = $workspace_id
RETURNING id;

-- PREP: session_generation_policy_read
-- {§session-model-selection}/{§session-effort} — one durable generation policy.
SELECT model_route_id, spawn_model_route_id, effort, effort_source FROM sessions WHERE id = $id;

-- PREP: session_generation_policy_update
-- {§session-model-selection}: test liveness in the policy write, not before it.
UPDATE sessions
SET model_route_id = $model_route_id,
    spawn_model_route_id = $spawn_model_route_id,
    effort = $effort,
    effort_source = $effort_source,
    version = version + 1
WHERE id = $id
  AND (
      model_route_id IS NULL
      OR (model_route_id IS $model_route_id
       AND spawn_model_route_id IS $spawn_model_route_id
       AND effort IS $effort)
      OR NOT EXISTS (
          SELECT 1 FROM loops
          WHERE session_id = sessions.id AND status IN (100, 102, 202)
      )
  )
RETURNING id;

-- PREP: session_generation_policy_selectable
-- Avoid provider setup for a disallowed change; the write rechecks after setup.
SELECT id FROM sessions
WHERE id = $id
  AND (
      model_route_id IS NULL
      OR (model_route_id IS $model_route_id
       AND spawn_model_route_id IS $spawn_model_route_id
       AND effort IS $effort)
      OR NOT EXISTS (
          SELECT 1 FROM loops
          WHERE session_id = sessions.id AND status IN (100, 102, 202)
      )
  );

-- PREP: envelope_list_workspace_prompts
-- {§methods-workspace-prompts}: nonempty loop seeds a client addressed to a model session,
-- newest-first, optionally one session's. Authorship is the seed message's address: a session-issued
-- seed (WORK, FORK, SEND to a session) carries none, so the model's own task prompts are not history
-- whichever session they seeded, and a human prompt at a forked session is.
SELECT l.prompt
FROM loops l
JOIN sessions r ON r.id = l.session_id
WHERE r.workspace_id = $workspace_id
  AND r.origin = 'model'
  AND ($session_id IS NULL OR l.session_id = $session_id)
  AND length(l.prompt) > 0
  AND EXISTS (SELECT 1 FROM loop_messages m WHERE m.loop_id = l.id AND m.ordinal = 1 AND m.address IS NOT NULL)
ORDER BY l.id DESC
LIMIT $limit;

-- PREP: envelope_insert_client_loop
-- sequence is auto-computed: 1 + max(existing sequence in this session) so concurrent
-- operations in one session get distinct loops. An administrative loop runs no model turns,
-- so no turn ceiling governs it (-1); its prompt source is the actor that opened it, if any.
INSERT INTO loops (session_id, sequence, status, prompt, prompt_source, max_turns)
VALUES ($session_id, COALESCE((SELECT MAX(sequence) FROM loops WHERE session_id = $session_id), 0) + 1, 102, '', $prompt_source, -1)
RETURNING id, sequence;

-- PREP: envelope_client_operation_person
-- {§actor-boundary-client-operations} The person a client operation speaks for: the prompt source of a
-- runtime-session loop. The daemon's own loops there name none.
SELECT l.prompt_source AS person
FROM loops l JOIN sessions w ON w.id = l.session_id
WHERE l.id = $loop_id AND w.origin = '_plurnk' AND l.prompt_source IS NOT NULL;

-- PREP: envelope_close_client_loop
UPDATE loops
SET status = $status,
    terminal_result = $result
WHERE id = $loop_id AND status = 102;

-- PREP: envelope_list_workspaces
-- {§machine-processes} $hidden: null lists every workspace, 1 only hidden ones, 0 only shown ones.
SELECT id, name, project_root, created_at, hidden_at
FROM workspaces
WHERE $hidden IS NULL OR (hidden_at IS NOT NULL) = $hidden
ORDER BY created_at DESC;
