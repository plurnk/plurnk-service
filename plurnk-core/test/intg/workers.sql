-- PREP: test_runs_table_sql
SELECT sql FROM sqlite_master WHERE name = 'workers';

-- PREP: test_runs_insert
INSERT INTO workers (workspace_id, name) VALUES ($workspace_id, $name);

-- PREP: test_runs_insert_with_parent
INSERT INTO workers (workspace_id, name, parent_worker_id) VALUES ($workspace_id, $name, $parent_worker_id);

-- PREP: test_runs_insert_with_parent_returning
INSERT INTO workers (workspace_id, name, parent_worker_id) VALUES ($workspace_id, $name, $parent_worker_id) RETURNING id;

-- PREP: test_runs_insert_returning
INSERT INTO workers (workspace_id, name) VALUES ($workspace_id, $name) RETURNING id;

-- PREP: test_runs_insert_cost
INSERT INTO workers (workspace_id, name, cost_usd) VALUES ($workspace_id, $name, $cost_usd);

-- PREP: test_runs_insert_version
INSERT INTO workers (workspace_id, name, version) VALUES ($workspace_id, $name, $version);

-- PREP: test_runs_get_by_session
SELECT id, version, workspace_id, name, created_at, parent_worker_id, cost_usd
FROM workers WHERE workspace_id = $workspace_id AND origin != 'plurnk' LIMIT 1;

-- PREP: test_runs_get_parent
SELECT parent_worker_id FROM workers WHERE id = $id;

-- PREP: test_runs_set_parent
UPDATE workers SET parent_worker_id = $parent_worker_id WHERE id = $id;

-- PREP: test_runs_count
-- excludes the ambient reserved rows (origin plurnk: commons/kernel) — the contract counts test-inserted runs
SELECT COUNT(*) AS n FROM workers WHERE origin != 'plurnk';

-- PREP: test_runs_get_workspace_id
SELECT workspace_id FROM workers WHERE workspace_id IS NOT NULL LIMIT 1;

-- PREP: test_runs_get_one_workspace_id
SELECT workspace_id FROM workers WHERE origin != 'plurnk';

-- PREP: test_sessions_delete
DELETE FROM workspaces WHERE id = $id;

-- PREP: test_runs_delete
DELETE FROM workers WHERE id = $id;

-- PREP: test_runs_list_by_session
SELECT id FROM workers WHERE workspace_id = $workspace_id AND origin != 'plurnk' ORDER BY id;

-- PREP: test_runs_index_exists
SELECT name FROM sqlite_master WHERE type = 'index' AND name = $name;

-- PREP: test_runs_trunk_lookup
SELECT id FROM workers WHERE workspace_id = $workspace_id AND origin != 'plurnk' AND parent_worker_id IS NULL;

-- EXEC: test_runs_insert_default_values
INSERT INTO workers DEFAULT VALUES;
