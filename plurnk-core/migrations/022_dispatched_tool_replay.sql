-- MIGRATE: 22 dispatched tool replay
-- {§db-migrations} {§log-history-projection} {§emission-history} Remove retired pre-#1352 workspace:///_plurnk generated entries and retain active projections on dispatched emissionIndex operations so native tool calls replay without amnesia.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 5.0.0 support floor (schema version 11); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

-- 1. Remove retired pre-#1352 workspace:///_plurnk generated entries superseded by plurnk:/// and mcp:///.
DELETE FROM entries
WHERE scheme = 'workspace'
  AND authority = ''
  AND (pathname = '/_plurnk' OR substr(pathname, 1, 9) = '/_plurnk/');

-- 2. Re-activate dispatched tool-call receipts (emissionIndex integer) that were never explicitly retired by log curation.
DROP TRIGGER IF EXISTS log_entry_projections_kill_terminal;

UPDATE log_entry_projections
SET active = 1
WHERE active = 0
  AND NOT EXISTS (
      SELECT 1 FROM log_curation_effects e
      WHERE e.target_log_entry_id = log_entry_projections.log_entry_id
        AND e.active_after = 0
  )
  AND EXISTS (
      SELECT 1
      FROM log_entry_rows r
      JOIN turns t ON t.id = r.turn_id
      WHERE r.id = log_entry_projections.log_entry_id
        AND json_type(r.attrs, '$.emissionIndex') = 'integer'
        AND NOT (t.producer = '_plurnk' AND t.kind = 'maintenance' AND r.source IS NULL)
  );

CREATE TRIGGER log_entry_projections_kill_terminal
BEFORE UPDATE OF active ON log_entry_projections
WHEN OLD.active = 0 AND NEW.active != 0
BEGIN
    SELECT RAISE(ABORT, 'a killed log entry cannot re-enter the active projection');
END;
