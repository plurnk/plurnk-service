-- Envelope lifecycle queries. SPEC §13.7.

-- PREP: envelope_insert_session
INSERT INTO sessions (name) VALUES ($name) RETURNING id, name;

-- PREP: envelope_get_session
SELECT id, name FROM sessions WHERE id = $id;

-- PREP: envelope_insert_run
INSERT INTO runs (session_id, name) VALUES ($session_id, $name) RETURNING id, name;

-- PREP: envelope_get_run_by_id
SELECT id, name, session_id FROM runs WHERE id = $id;

-- PREP: envelope_get_run_by_name
SELECT id, name FROM runs WHERE session_id = $session_id AND name = $name;

-- PREP: envelope_list_runs_for_session
SELECT id, name, created_at, cost_pico
FROM runs
WHERE session_id = $session_id
ORDER BY created_at DESC;

-- PREP: envelope_insert_client_loop
-- sequence is auto-computed: 1 + max(existing sequence in this run) so
-- multiple client connections attaching to the same run get distinct loops.
INSERT INTO loops (run_id, sequence, status, prompt)
VALUES ($run_id, COALESCE((SELECT MAX(sequence) FROM loops WHERE run_id = $run_id), 0) + 1, 102, '')
RETURNING id;

-- PREP: envelope_close_client_loop
UPDATE loops SET status = $status WHERE id = $loop_id AND status = 102;

-- PREP: envelope_list_sessions
SELECT id, name, created_at, cost_pico
FROM sessions
ORDER BY created_at DESC;
