-- MIGRATE: 13 acp v2 session lifecycle
-- {§db-migrations} Refuse databases from before the 5.0.0 support floor, naming both versions read.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 5.0.0 support floor (schema version 11); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

DROP TRIGGER IF EXISTS loops_unhide_place;
DROP TRIGGER IF EXISTS sessions_join_hidden_group;
DROP INDEX IF EXISTS sessions_hidden_by;

ALTER TABLE workspaces RENAME COLUMN hidden_at TO archived_at;
ALTER TABLE sessions RENAME COLUMN hidden_at TO archived_at;
ALTER TABLE sessions RENAME COLUMN hidden_by TO archived_by;
ALTER TABLE sessions ADD COLUMN title TEXT CHECK (title IS NULL OR length(title) > 0);

CREATE INDEX sessions_archived_by ON sessions (archived_by) WHERE archived_by IS NOT NULL;

DROP TRIGGER IF EXISTS log_entries_ambient_event_once;
CREATE TRIGGER log_entries_ambient_event_once
BEFORE UPDATE OF ambient_event_id ON log_entries
WHEN NOT (
    (OLD.ambient_event_id IS NULL AND NEW.ambient_event_id IS NOT NULL)
    OR (NEW.ambient_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM ambient_events WHERE id = OLD.ambient_event_id))
)
BEGIN
    SELECT RAISE(ABORT, 'log_entries ambient event identity may only be assigned once');
END;
