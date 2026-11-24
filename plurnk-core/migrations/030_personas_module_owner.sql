-- MIGRATE: 30 personas module namespace owner
-- {§db-migrations} {§persona-discovery}
-- Migrate persisted workspace_module_state persona entries to `@plurnk/plurnk-personas` in place.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'workspaces_project_root')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 8.0.0 support floor (schema version 25); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

DELETE FROM workspace_module_state
WHERE namespace_owner = '@plurnk/plurnk-service:personas'
  AND EXISTS (
      SELECT 1
      FROM workspace_module_state AS existing
      WHERE existing.workspace_id = workspace_module_state.workspace_id
        AND existing.namespace_owner = '@plurnk/plurnk-personas'
  );

UPDATE workspace_module_state
SET namespace_owner = '@plurnk/plurnk-personas'
WHERE namespace_owner = '@plurnk/plurnk-service:personas';
