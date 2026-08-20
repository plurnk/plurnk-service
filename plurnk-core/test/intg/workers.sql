-- PREP: test_workers_table_sql
SELECT sql FROM sqlite_master WHERE name = 'workers';

-- PREP: test_workers_insert
INSERT INTO workers (workspace_id, name) VALUES ($workspace_id, $name);

-- PREP: test_workers_insert_with_parent
INSERT INTO workers (workspace_id, name, parent_worker_id) VALUES ($workspace_id, $name, $parent_worker_id);

-- PREP: test_workers_insert_with_parent_returning
INSERT INTO workers (workspace_id, name, parent_worker_id) VALUES ($workspace_id, $name, $parent_worker_id) RETURNING id;

-- PREP: test_workers_insert_returning
INSERT INTO workers (workspace_id, name) VALUES ($workspace_id, $name) RETURNING id;

-- PREP: test_workers_insert_default_conversation
INSERT INTO workers (workspace_id, name, parent_worker_id, origin, default_conversation)
VALUES ($workspace_id, $name, $parent_worker_id, $origin, 1);

-- PREP: test_workers_insert_version
INSERT INTO workers (workspace_id, name, version) VALUES ($workspace_id, $name, $version);

-- PREP: test_workers_get_by_workspace
SELECT id, version, workspace_id, name, created_at, parent_worker_id, provider_identity
FROM workers WHERE workspace_id = $workspace_id AND origin != '_plurnk' LIMIT 1;

-- PREP: test_workers_get_provider_identity
SELECT provider_identity FROM workers WHERE id = $id;

-- PREP: test_workers_insert_provider_identity
INSERT INTO workers (workspace_id, name, provider_identity)
VALUES ($workspace_id, $name, $provider_identity);

-- PREP: test_workers_update_provider_identity
UPDATE workers SET provider_identity = $provider_identity WHERE id = $id;

-- PREP: test_workers_get_parent
SELECT parent_worker_id FROM workers WHERE id = $id;

-- PREP: test_workers_set_parent
UPDATE workers SET parent_worker_id = $parent_worker_id WHERE id = $id;

-- PREP: test_workers_count
-- Excludes the ambient reserved rows (origin _plurnk: commons/kernel); the contract counts test-inserted workers.
SELECT COUNT(*) AS n FROM workers WHERE origin != '_plurnk';

-- PREP: test_workers_get_workspace_id
SELECT workspace_id FROM workers WHERE workspace_id IS NOT NULL LIMIT 1;

-- PREP: test_workers_get_one_workspace_id
SELECT workspace_id FROM workers WHERE origin != '_plurnk';

-- PREP: test_workspaces_delete
DELETE FROM workspaces WHERE id = $id;

-- PREP: test_workers_delete
DELETE FROM workers WHERE id = $id;

-- PREP: test_workers_list_by_workspace
SELECT id FROM workers WHERE workspace_id = $workspace_id AND origin != '_plurnk' ORDER BY id;

-- PREP: test_workers_index_exists
SELECT name FROM sqlite_master WHERE type = 'index' AND name = $name;

-- PREP: test_workers_root_lookup
SELECT id FROM workers WHERE workspace_id = $workspace_id AND origin != '_plurnk' AND parent_worker_id IS NULL;

-- EXEC: test_workers_insert_default_values
INSERT INTO workers DEFAULT VALUES;
