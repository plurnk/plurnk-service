-- Envelope lifecycle queries. SPEC §13.7.

-- PREP: envelope_insert_session
INSERT INTO sessions (name) VALUES ($name) RETURNING id, name;

-- PREP: envelope_get_session
SELECT id, name FROM sessions WHERE id = $id;

-- PREP: envelope_insert_run
INSERT INTO runs (session_id) VALUES ($session_id) RETURNING id;

-- PREP: envelope_insert_client_loop
INSERT INTO loops (run_id, sequence, status, prompt)
VALUES ($run_id, 1, 102, '')
RETURNING id;

-- PREP: envelope_close_client_loop
UPDATE loops SET status = $status WHERE id = $loop_id AND status = 102;

-- PREP: envelope_list_sessions
SELECT id, name, created_at, cost_pico
FROM sessions
ORDER BY created_at DESC;
