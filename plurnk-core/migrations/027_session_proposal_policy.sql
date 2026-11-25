-- MIGRATE: 27 session and loop proposal policy
-- Released in 9.0.0 and frozen ({§db-migrations}).
-- {§db-migrations} {§proposal-disposition} {§session-model-selection}
-- Narrow proposal policy across service -> workspace -> session -> loop without editing released migrations.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'workspaces_project_root')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 8.0.0 support floor (schema version 25); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

ALTER TABLE sessions ADD COLUMN proposal_policy TEXT CHECK (proposal_policy IS NULL OR proposal_policy IN ('review', 'accept', 'reject'));
ALTER TABLE loops ADD COLUMN proposal_policy TEXT CHECK (proposal_policy IS NULL OR proposal_policy IN ('review', 'accept', 'reject'));
