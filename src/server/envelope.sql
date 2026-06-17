-- Envelope lifecycle queries. SPEC §connection-lifecycle.

-- PREP: envelope_insert_session
INSERT INTO sessions (name, project_root, settings)
VALUES ($name, $project_root, $settings)
RETURNING id, name, project_root;

-- PREP: envelope_get_session
SELECT id, name, project_root FROM sessions WHERE id = $id;

-- PREP: envelope_update_session_project_root
-- Used by session.set_root (F.1). Returns the updated row so the caller can
-- refresh its ClientEnvelope copy without a second query.
UPDATE sessions SET project_root = $project_root WHERE id = $id
RETURNING id, name, project_root;

-- PREP: envelope_insert_run
-- origin is the run's actor (§machine-processes): 'model' (the conversation),
-- 'client' (a connection's own run), or 'plurnk' (the runtime self-hosting run).
INSERT INTO runs (session_id, name, origin)
VALUES ($session_id, $name, $origin)
RETURNING id, name, origin;

-- PREP: envelope_get_run_by_id
SELECT id, name, session_id FROM runs WHERE id = $id;

-- PREP: envelope_get_run_by_name
SELECT id, name FROM runs WHERE session_id = $session_id AND name = $name;

-- PREP: envelope_list_runs_for_session
SELECT id, name, created_at, cost_pico, origin
FROM runs
WHERE session_id = $session_id
ORDER BY created_at DESC;

-- PREP: envelope_list_session_prompts
-- #238 — a session's user prompts for client up/down history: the conversation run's
-- non-empty loop seeds, newest-first, capped. The conversation run is origin='model' +
-- parentless; spawned/forked run:// sub-runs (parent_run_id set) are excluded — their
-- seed prompts are not user input.
SELECT l.prompt
FROM loops l
JOIN runs r ON r.id = l.run_id
WHERE r.session_id = $session_id
  AND r.origin = 'model'
  AND r.parent_run_id IS NULL
  AND length(l.prompt) > 0
ORDER BY l.id DESC
LIMIT $limit;

-- PREP: envelope_insert_client_loop
-- sequence is auto-computed: 1 + max(existing sequence in this run) so
-- multiple client connections attaching to the same run get distinct loops.
INSERT INTO loops (run_id, sequence, status, prompt)
VALUES ($run_id, COALESCE((SELECT MAX(sequence) FROM loops WHERE run_id = $run_id), 0) + 1, 102, '')
RETURNING id;

-- PREP: envelope_close_client_loop
UPDATE loops SET status = $status WHERE id = $loop_id AND status = 102;

-- PREP: envelope_list_sessions
SELECT id, name, project_root, created_at, cost_pico
FROM sessions
ORDER BY created_at DESC;
