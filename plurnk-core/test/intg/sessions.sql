-- PREP: test_sessions_table_sql
SELECT sql FROM sqlite_master WHERE name = 'sessions';

-- PREP: test_sessions_insert
INSERT INTO sessions (workspace_id, name) VALUES ($workspace_id, $name);

-- PREP: test_sessions_insert_with_parent
INSERT INTO sessions (workspace_id, name, parent_session_id) VALUES ($workspace_id, $name, $parent_session_id);

-- PREP: test_sessions_insert_with_parent_returning
INSERT INTO sessions (workspace_id, name, parent_session_id) VALUES ($workspace_id, $name, $parent_session_id) RETURNING id;

-- PREP: test_sessions_insert_returning
INSERT INTO sessions (workspace_id, name) VALUES ($workspace_id, $name) RETURNING id;

-- PREP: test_sessions_insert_version
INSERT INTO sessions (workspace_id, name, version) VALUES ($workspace_id, $name, $version);

-- PREP: test_sessions_get_by_workspace
SELECT id, version, workspace_id, name, created_at, parent_session_id, provider_identity
FROM sessions WHERE workspace_id = $workspace_id AND origin != '_plurnk' LIMIT 1;

-- PREP: test_sessions_get_provider_identity
SELECT provider_identity FROM sessions WHERE id = $id;

-- PREP: test_sessions_insert_provider_identity
INSERT INTO sessions (workspace_id, name, provider_identity)
VALUES ($workspace_id, $name, $provider_identity);

-- PREP: test_sessions_update_provider_identity
UPDATE sessions SET provider_identity = $provider_identity WHERE id = $id;

-- PREP: test_sessions_get_parent
SELECT parent_session_id FROM sessions WHERE id = $id;

-- PREP: test_sessions_set_parent
UPDATE sessions SET parent_session_id = $parent_session_id WHERE id = $id;

-- PREP: test_sessions_count
-- Excludes the ambient reserved rows (origin _plurnk: commons/kernel); the contract counts test-inserted sessions.
SELECT COUNT(*) AS n FROM sessions WHERE origin != '_plurnk';

-- PREP: test_sessions_get_workspace_id
SELECT workspace_id FROM sessions WHERE workspace_id IS NOT NULL LIMIT 1;

-- PREP: test_sessions_get_one_workspace_id
SELECT workspace_id FROM sessions WHERE origin != '_plurnk';

-- PREP: test_workspaces_delete
DELETE FROM workspaces WHERE id = $id;

-- PREP: test_sessions_delete
DELETE FROM sessions WHERE id = $id;

-- PREP: test_sessions_list_by_workspace
SELECT id FROM sessions WHERE workspace_id = $workspace_id AND origin != '_plurnk' ORDER BY id;

-- PREP: test_sessions_index_exists
SELECT name FROM sqlite_master WHERE type = 'index' AND name = $name;

-- PREP: test_sessions_root_lookup
SELECT id FROM sessions WHERE workspace_id = $workspace_id AND origin != '_plurnk' AND parent_session_id IS NULL;

-- EXEC: test_sessions_insert_default_values
INSERT INTO sessions DEFAULT VALUES;

-- PREP: test_get_session_cancellation
SELECT cancellation FROM sessions WHERE id = $id;
