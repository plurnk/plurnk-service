-- PREP: test_runs_table_sql
SELECT sql FROM sqlite_master WHERE name = 'runs';

-- PREP: test_runs_insert
INSERT INTO runs (session_id, name) VALUES ($session_id, $name);

-- PREP: test_runs_insert_with_parent
INSERT INTO runs (session_id, name, parent_run_id) VALUES ($session_id, $name, $parent_run_id);

-- PREP: test_runs_insert_with_parent_returning
INSERT INTO runs (session_id, name, parent_run_id) VALUES ($session_id, $name, $parent_run_id) RETURNING id;

-- PREP: test_runs_insert_returning
INSERT INTO runs (session_id, name) VALUES ($session_id, $name) RETURNING id;

-- PREP: test_runs_insert_cost
INSERT INTO runs (session_id, name, cost_pico) VALUES ($session_id, $name, $cost_pico);

-- PREP: test_runs_insert_version
INSERT INTO runs (session_id, name, version) VALUES ($session_id, $name, $version);

-- PREP: test_runs_get_by_session
SELECT id, version, session_id, name, created_at, parent_run_id, cost_pico
FROM runs WHERE session_id = $session_id LIMIT 1;

-- PREP: test_runs_get_parent
SELECT parent_run_id FROM runs WHERE id = $id;

-- PREP: test_runs_set_parent
UPDATE runs SET parent_run_id = $parent_run_id WHERE id = $id;

-- PREP: test_runs_count
SELECT COUNT(*) AS n FROM runs;

-- PREP: test_runs_get_session_id
SELECT session_id FROM runs WHERE session_id IS NOT NULL LIMIT 1;

-- PREP: test_runs_get_one_session_id
SELECT session_id FROM runs;

-- PREP: test_sessions_delete
DELETE FROM sessions WHERE id = $id;

-- PREP: test_runs_delete
DELETE FROM runs WHERE id = $id;

-- PREP: test_runs_list_by_session
SELECT id FROM runs WHERE session_id = $session_id ORDER BY id;

-- PREP: test_runs_index_exists
SELECT name FROM sqlite_master WHERE type = 'index' AND name = $name;

-- PREP: test_runs_trunk_lookup
SELECT id FROM runs WHERE session_id = $session_id AND parent_run_id IS NULL;

-- EXEC: test_runs_insert_default_values
INSERT INTO runs DEFAULT VALUES;
