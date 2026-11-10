-- MIGRATE: 15 session message keys
-- Released in 6.0.0 and frozen ({§db-migrations}).
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

-- {§db-migrations} {§message-arrival}: scope message_key uniqueness to the receiving session
-- rather than the whole loop_messages table so every (session, principal) stream starts at 00.
DROP INDEX IF EXISTS loop_messages_key;

DROP TRIGGER IF EXISTS loop_messages_key_unique;
CREATE TRIGGER loop_messages_key_unique
BEFORE INSERT ON loop_messages
WHEN EXISTS (
    SELECT 1 FROM loop_messages m
    JOIN loops l ON l.id = m.loop_id
    WHERE m.message_key = NEW.message_key AND l.session_id = (
        SELECT l2.session_id FROM loops l2 WHERE l2.id = NEW.loop_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'message_key already accepted in this session');
END;
