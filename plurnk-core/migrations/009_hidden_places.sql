-- MIGRATE: 9 hidden places
-- Released in 4.3.0 and frozen ({§db-migrations}).
-- {§db-migrations} Refuse databases from before the 4.0.0 support floor, naming the stepping-stone release.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema precedes the 4.0.0 support floor; upgrade through @plurnk/plurnk-service@4.3.3 first ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

-- {§machine-processes} A hidden workspace or session is marked, never deleted. A session's hide marks it and every session
-- beneath it with the session that hid it (`hidden_by`), the group that comes back whole.
ALTER TABLE workspaces ADD COLUMN hidden_at TEXT CHECK (hidden_at IS NULL OR length(hidden_at) > 0);
ALTER TABLE sessions ADD COLUMN hidden_at TEXT CHECK (hidden_at IS NULL OR length(hidden_at) > 0);
ALTER TABLE sessions ADD COLUMN hidden_by INTEGER REFERENCES sessions(id)
    CHECK ((hidden_at IS NULL) = (hidden_by IS NULL));

CREATE INDEX sessions_hidden_by ON sessions (hidden_by) WHERE hidden_by IS NOT NULL;
