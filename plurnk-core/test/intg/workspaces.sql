-- Schema-DDL test PREPs for workspaces.test.ts. All test_workspaces_* are
-- exclusively for testing constraints on the workspaces table.

-- PREP: test_workspaces_table_sql
SELECT sql FROM sqlite_master WHERE name = 'workspaces';

-- PREP: test_workspaces_insert_name_only
INSERT INTO workspaces (name) VALUES ($name);

-- PREP: test_workspaces_get_by_name
SELECT id, version, name, created_at, cost_usd, scheme_registry_additions
FROM workspaces WHERE name = $name;

-- PREP: test_workspaces_insert_with_cost
INSERT INTO workspaces (name, cost_usd) VALUES ($name, $cost_usd);

-- PREP: test_workspaces_insert_with_version
INSERT INTO workspaces (name, version) VALUES ($name, $version);

-- PREP: test_workspaces_insert_with_sra
INSERT INTO workspaces (name, scheme_registry_additions) VALUES ($name, $sra);

-- PREP: test_workspaces_get_sra
SELECT scheme_registry_additions FROM workspaces WHERE name = $name;

-- PREP: test_workspaces_get_cost
SELECT cost_usd FROM workspaces WHERE name = $name;

-- PREP: test_workspaces_index_exists
SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'workspaces_created_at';

-- PREP: test_workspaces_list_ordered
SELECT id, name FROM workspaces ORDER BY id;

-- EXEC: test_workspaces_insert_no_name
-- Used to verify NOT NULL on name; this raw INSERT omits the column.
INSERT INTO workspaces (cost_usd) VALUES (0);
