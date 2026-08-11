-- Envelope lifecycle queries. SPEC {§connection-lifecycle}.

-- PREP: envelope_insert_workspace
INSERT INTO workspaces (name, project_root, settings)
VALUES ($name, $project_root, $settings)
ON CONFLICT(name) DO NOTHING
RETURNING id, name, project_root;

-- PREP: envelope_get_workspace
SELECT id, name, project_root FROM workspaces WHERE id = $id;


-- PREP: envelope_get_workspace_by_name
-- workspace.rename collision check — workspaces.name is UNIQUE.
SELECT id FROM workspaces WHERE name = $name;

-- PREP: envelope_set_workspace_name
-- Used by workspace.rename. The workspace name is a MUTABLE handle (vs a worker's
-- immutable name, {§machine-processes}). Returns the updated row to refresh the
-- caller's ClientEnvelope copy.
UPDATE workspaces SET name = $name
WHERE id = $id
  AND NOT EXISTS (
    SELECT 1 FROM workspaces AS other
    WHERE other.name = $name AND other.id <> $id
  )
RETURNING id, name;

-- PREP: envelope_insert_worker
-- origin is the worker's actor ({§machine-processes}): 'model' (the conversation),
-- 'client' (a connection's own worker), or 'plurnk' (the runtime self-hosting worker).
INSERT INTO workers (workspace_id, name, origin)
VALUES ($workspace_id, $name, $origin)
RETURNING id, name, origin;

-- PREP: envelope_get_worker_by_id
SELECT id, name, workspace_id, origin FROM workers WHERE id = $id;

-- PREP: envelope_get_worker_by_name
SELECT id, name FROM workers WHERE workspace_id = $workspace_id AND name = $name;

-- PREP: envelope_list_workers_for_workspace
SELECT id, name, created_at, origin
FROM workers
WHERE workspace_id = $workspace_id
ORDER BY created_at DESC;

-- PREP: envelope_list_workspace_prompts
-- {§methods-workspace-prompts}: nonempty model-root loop seeds, newest-first;
-- spawned and forked children are not workspace-level user prompt history.
SELECT l.prompt
FROM loops l
JOIN workers r ON r.id = l.worker_id
WHERE r.workspace_id = $workspace_id
  AND r.origin = 'model'
  AND r.parent_worker_id IS NULL
  AND length(l.prompt) > 0
ORDER BY l.id DESC
LIMIT $limit;

-- PREP: envelope_insert_client_loop
-- sequence is auto-computed: 1 + max(existing sequence in this worker) so
-- multiple client connections attaching to the same worker get distinct loops.
INSERT INTO loops (worker_id, sequence, status, prompt)
VALUES ($worker_id, COALESCE((SELECT MAX(sequence) FROM loops WHERE worker_id = $worker_id), 0) + 1, 102, '')
RETURNING id, sequence;

-- PREP: envelope_close_client_loop
UPDATE loops
SET status = $status,
    terminal_result = $result
WHERE id = $loop_id AND status = 102;

-- PREP: envelope_list_workspaces
SELECT id, name, project_root, created_at
FROM workspaces
ORDER BY created_at DESC;
