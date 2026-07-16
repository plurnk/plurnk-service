-- Envelope lifecycle queries. SPEC §connection-lifecycle.

-- PREP: envelope_insert_workspace
INSERT INTO workspaces (name, project_root, settings)
VALUES ($name, $project_root, $settings)
RETURNING id, name, project_root;

-- PREP: envelope_get_workspace
SELECT id, name, project_root FROM workspaces WHERE id = $id;


-- PREP: envelope_get_workspace_by_name
-- workspace.rename collision check — workspaces.name is UNIQUE.
SELECT id FROM workspaces WHERE name = $name;

-- PREP: envelope_set_workspace_name
-- Used by workspace.rename. The workspace name is a MUTABLE handle (vs a run's
-- immutable name, §machine-processes). Returns the updated row to refresh the
-- caller's ClientEnvelope copy.
UPDATE workspaces SET name = $name WHERE id = $id
RETURNING id, name;

-- PREP: envelope_insert_worker
-- origin is the run's actor (§machine-processes): 'model' (the conversation),
-- 'client' (a connection's own run), or 'plurnk' (the runtime self-hosting run).
INSERT INTO workers (workspace_id, name, origin)
VALUES ($workspace_id, $name, $origin)
RETURNING id, name, origin;

-- PREP: envelope_get_worker_by_id
SELECT id, name, workspace_id, origin FROM workers WHERE id = $id;

-- PREP: envelope_get_worker_by_name
SELECT id, name FROM workers WHERE workspace_id = $workspace_id AND name = $name;

-- PREP: envelope_list_workers_for_workspace
SELECT id, name, created_at, cost_pico, origin
FROM workers
WHERE workspace_id = $workspace_id
ORDER BY created_at DESC;

-- PREP: envelope_list_workspace_prompts
-- #238 — a workspace's user prompts for client up/down history: the conversation run's
-- non-empty loop seeds, newest-first, capped. The conversation run is origin='model' +
-- parentless; spawned/forked worker:// sub-runs (parent_worker_id set) are excluded — their
-- seed prompts are not user input.
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
-- sequence is auto-computed: 1 + max(existing sequence in this run) so
-- multiple client connections attaching to the same run get distinct loops.
INSERT INTO loops (worker_id, sequence, status, prompt)
VALUES ($worker_id, COALESCE((SELECT MAX(sequence) FROM loops WHERE worker_id = $worker_id), 0) + 1, 102, '')
RETURNING id;

-- PREP: envelope_close_client_loop
UPDATE loops SET status = $status WHERE id = $loop_id AND status = 102;

-- PREP: envelope_list_workspaces
SELECT id, name, project_root, created_at, cost_pico
FROM workspaces
ORDER BY created_at DESC;

-- PREP: envelope_get_model_worker
-- #371 — the workspace's canonical model CONVERSATION run: the earliest model-origin ROOT run
-- (parent_worker_id NULL excludes forks and spawned workers, which inherit origin='model').
-- ensureModelWorker finds this first; only a workspace with none mints one.
SELECT id FROM workers WHERE workspace_id = $workspace_id AND origin = 'model' AND parent_worker_id IS NULL ORDER BY id LIMIT 1;
