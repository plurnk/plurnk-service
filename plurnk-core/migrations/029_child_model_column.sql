-- MIGRATE: 29 child model route column
-- {§db-migrations} {§session-model-selection}
-- Totalize child model naming on sessions and loops (`spawn_model_route_id` -> `child_model_route_id`) in place.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'workspaces_project_root')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 8.0.0 support floor (schema version 25); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

DROP TRIGGER IF EXISTS loops_settle_mailbox_on_terminate;
DROP TRIGGER IF EXISTS sessions_sync_live_loop_generation_policy;
DROP TRIGGER IF EXISTS sessions_fork_copies_history;
DROP INDEX IF EXISTS sessions_spawn_model_route_id;
DROP INDEX IF EXISTS loops_spawn_model_route_id;

ALTER TABLE sessions RENAME COLUMN spawn_model_route_id TO child_model_route_id;
ALTER TABLE loops RENAME COLUMN spawn_model_route_id TO child_model_route_id;

CREATE INDEX sessions_child_model_route_id ON sessions (child_model_route_id) WHERE child_model_route_id IS NOT NULL;
CREATE INDEX loops_child_model_route_id ON loops (child_model_route_id) WHERE child_model_route_id IS NOT NULL;
