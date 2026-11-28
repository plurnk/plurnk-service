-- MIGRATE: 31 service tier and workspace config
-- Released in 10.0.0 and frozen ({§db-migrations}).
-- {§db-migrations} {§operator-config-precedence} {§functionality-coordinator}
-- Add durable daemon-wide service_config, service_module_state, and workspace_config tables;
-- migrate legacy workspaces.settings knob shadows into workspace_config under canonical PLURNK_SERVICE_* keys;
-- and rename persisted external Functionality origin `"service"` to `"host"`.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'workspaces_project_root')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 8.0.0 support floor (schema version 25); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

CREATE TABLE service_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_config (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (workspace_id, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE service_module_state (
    namespace_owner TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (json_valid(state))
) STRICT, WITHOUT ROWID;

INSERT OR REPLACE INTO workspace_config (workspace_id, key, value)
SELECT id, 'PLURNK_SERVICE_FILES_ITEMS', CAST(json_extract(settings, '$.filesItems') AS TEXT)
FROM workspaces
WHERE json_valid(settings)
  AND json_type(settings, '$.filesItems') IN ('integer', 'real');

INSERT OR REPLACE INTO workspace_config (workspace_id, key, value)
SELECT id, 'PLURNK_SERVICE_MAX_COMMANDS', CAST(json_extract(settings, '$.maxCommands') AS TEXT)
FROM workspaces
WHERE json_valid(settings)
  AND json_type(settings, '$.maxCommands') IN ('integer', 'real');

INSERT OR REPLACE INTO workspace_config (workspace_id, key, value)
SELECT id, 'PLURNK_SERVICE_GIT_ALLOWED',
       CASE WHEN json_type(settings, '$.git') = 'false' THEN '0' ELSE '1' END
FROM workspaces
WHERE json_valid(settings)
  AND json_type(settings, '$.git') IN ('true', 'false');

INSERT OR REPLACE INTO workspace_config (workspace_id, key, value)
SELECT id, 'PLURNK_SERVICE_FILE_CREATE_SCOPE', json_extract(settings, '$.fileCreateScope')
FROM workspaces
WHERE json_valid(settings)
  AND json_type(settings, '$.fileCreateScope') = 'text';

INSERT OR REPLACE INTO workspace_config (workspace_id, key, value)
SELECT id, 'PLURNK_SERVICE_MEMBERS_MODEL_SCOPE', json_extract(settings, '$.membersModelScope')
FROM workspaces
WHERE json_valid(settings)
  AND json_type(settings, '$.membersModelScope') = 'text';

INSERT OR REPLACE INTO workspace_config (workspace_id, key, value)
SELECT id, 'PLURNK_SERVICE_PROPOSALS', json_extract(settings, '$.proposalPolicy')
FROM workspaces
WHERE json_valid(settings)
  AND json_type(settings, '$.proposalPolicy') = 'text';

UPDATE workspaces
SET settings = json_remove(
    settings,
    '$.filesItems',
    '$.maxCommands',
    '$.git',
    '$.fileCreateScope',
    '$.membersModelScope',
    '$.proposalPolicy'
)
WHERE json_valid(settings)
  AND (
    json_type(settings, '$.filesItems') IS NOT NULL
    OR json_type(settings, '$.maxCommands') IS NOT NULL
    OR json_type(settings, '$.git') IS NOT NULL
    OR json_type(settings, '$.fileCreateScope') IS NOT NULL
    OR json_type(settings, '$.membersModelScope') IS NOT NULL
    OR json_type(settings, '$.proposalPolicy') IS NOT NULL
  );

UPDATE workspace_module_state
SET state = json_set(
    state,
    '$.definitions',
    json(coalesce((
        SELECT json_group_object(
            key,
            json(CASE WHEN json_extract(value, '$.origin') = 'service'
                 THEN json_set(value, '$.origin', 'host')
                 ELSE value END)
        )
        FROM json_each(state, '$.definitions')
    ), '{}'))
)
WHERE json_type(state, '$.definitions') = 'object'
  AND EXISTS (
      SELECT 1 FROM json_each(state, '$.definitions')
      WHERE json_extract(value, '$.origin') = 'service'
  );

UPDATE session_module_state
SET state = json_set(
    state,
    '$.definitions',
    json(coalesce((
        SELECT json_group_object(
            key,
            json(CASE WHEN json_extract(value, '$.origin') = 'service'
                 THEN json_set(value, '$.origin', 'host')
                 ELSE value END)
        )
        FROM json_each(state, '$.definitions')
    ), '{}'))
)
WHERE json_type(state, '$.definitions') = 'object'
  AND EXISTS (
      SELECT 1 FROM json_each(state, '$.definitions')
      WHERE json_extract(value, '$.origin') = 'service'
  );
