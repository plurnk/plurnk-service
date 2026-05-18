-- Schema-DDL test PREPs for sessions.test.ts. All test_sessions_* are
-- exclusively for testing constraints on the sessions table.

-- PREP: test_sessions_table_sql
SELECT sql FROM sqlite_master WHERE name = 'sessions';

-- PREP: test_sessions_insert_name_only
INSERT INTO sessions (name) VALUES ($name);

-- PREP: test_sessions_get_by_name
SELECT id, version, name, created_at, cost_pico, scheme_registry_additions
FROM sessions WHERE name = $name;

-- PREP: test_sessions_insert_with_cost
INSERT INTO sessions (name, cost_pico) VALUES ($name, $cost_pico);

-- PREP: test_sessions_insert_with_version
INSERT INTO sessions (name, version) VALUES ($name, $version);

-- PREP: test_sessions_insert_with_sra
INSERT INTO sessions (name, scheme_registry_additions) VALUES ($name, $sra);

-- PREP: test_sessions_get_sra
SELECT scheme_registry_additions FROM sessions WHERE name = $name;

-- PREP: test_sessions_get_cost
SELECT cost_pico FROM sessions WHERE name = $name;

-- PREP: test_sessions_index_exists
SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_created_at';

-- PREP: test_sessions_list_ordered
SELECT id, name FROM sessions ORDER BY id;

-- EXEC: test_sessions_insert_no_name
-- Used to verify NOT NULL on name; this raw INSERT omits the column.
INSERT INTO sessions (cost_pico) VALUES (0);
