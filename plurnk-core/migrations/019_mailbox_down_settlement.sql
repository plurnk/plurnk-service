-- MIGRATE: 19 mailbox down settlement
-- {§db-migrations} {§loop-completion} {§message-completion} Settle every ended loop's unanswered mailbox rows atomically with nullable response_id ('DOWN' 499) and guard open-loop mailbox ownership (#1467).
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 5.0.0 support floor (schema version 11); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

DROP TRIGGER IF EXISTS log_entries_retire_message_completions;
DROP TRIGGER IF EXISTS loops_settle_mailbox_on_terminate;
DROP TRIGGER IF EXISTS message_complete_on_reply;
DROP TRIGGER IF EXISTS ambient_child_wake_revision;

COMMIT;
PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;
BEGIN IMMEDIATE;

-- 1. Rebuild message_completions with nullable response_id and ON DELETE SET NULL so
-- implicit loop-exit ('DOWN') settlement needs no synthetic log row and cross-session
-- responder history deletion preserves the caller's completed message state.
CREATE TABLE message_completions_new (
    message_id  INTEGER PRIMARY KEY REFERENCES loop_messages(id) ON DELETE CASCADE,
    response_id INTEGER REFERENCES log_entry_rows(id) ON DELETE SET NULL,
    status      INTEGER NOT NULL CHECK (status IN (200, 499))
) STRICT;

INSERT INTO message_completions_new (message_id, response_id, status)
SELECT message_id, response_id, status FROM message_completions;

DROP TABLE message_completions;
ALTER TABLE message_completions_new RENAME TO message_completions;

CREATE INDEX message_completions_response_id
    ON message_completions (response_id) WHERE response_id IS NOT NULL;

-- 2. Namespace reply ambient events by (messageId, source_record_id, recipient_session_id)
-- so loop-termination 'DOWN' replies (source_record_id = loops.id, $.messageId = loop_messages.id)
-- never collide with explicit log-entry replies (source_record_id = log_entry_rows.id, $.messageId IS NULL).
DROP INDEX IF EXISTS ambient_reply_recipient;
CREATE UNIQUE INDEX ambient_reply_recipient
    ON ambient_events (
        COALESCE(json_extract(attrs, '$.messageId'), 0),
        source_record_id,
        recipient_session_id
    ) WHERE kind = 'reply';

-- 3. Re-home any pre-existing unreceived follow-ups (ordinal > 1, log_entry_id IS NULL)
-- on non-cancelled terminal model loops into queued recovery incarnations.
INSERT INTO loops (
    session_id, sequence, status, prompt, prompt_source,
    model_route_id, spawn_model_route_id, effort, max_turns, orphan_source_loop_id
)
SELECT l.session_id,
       (SELECT COALESCE(MAX(sequence), 0) FROM loops WHERE session_id = l.session_id)
           + ROW_NUMBER() OVER (PARTITION BY l.session_id ORDER BY l.sequence ASC),
       100, m.body, m.source,
       l.model_route_id, l.spawn_model_route_id, l.effort, l.max_turns, l.id
FROM loops l
JOIN sessions w ON w.id = l.session_id
JOIN loop_messages m ON m.id = (
    SELECT id FROM loop_messages
    WHERE loop_id = l.id AND ordinal > 1 AND log_entry_id IS NULL
    ORDER BY ordinal ASC LIMIT 1
)
WHERE w.origin = 'model'
  AND l.status IN (200, 413, 429, 499, 500, 504, 508)
  AND l.terminated_by IS NOT 'cancel'
  AND l.sequence > w.cancelled_through_sequence
  AND NOT EXISTS (SELECT 1 FROM loops r WHERE r.orphan_source_loop_id = l.id);

UPDATE loop_messages
SET loop_id = orphaned.target_loop_id,
    ordinal = orphaned.new_ordinal
FROM (
    SELECT m.id,
           r.id AS target_loop_id,
           (SELECT COALESCE(MAX(ordinal), 0) FROM loop_messages WHERE loop_id = r.id)
               + ROW_NUMBER() OVER (PARTITION BY m.loop_id ORDER BY m.ordinal ASC) AS new_ordinal
    FROM loop_messages m
    JOIN loops l ON l.id = m.loop_id
    JOIN sessions w ON w.id = l.session_id
    JOIN loops r ON r.orphan_source_loop_id = l.id AND r.status = 100
    WHERE w.origin = 'model'
      AND l.status IN (200, 413, 429, 499, 500, 504, 508)
      AND l.terminated_by IS NOT 'cancel'
      AND l.sequence > w.cancelled_through_sequence
      AND m.ordinal > 1
      AND m.log_entry_id IS NULL
) AS orphaned
WHERE loop_messages.id = orphaned.id;

-- 4. Publish caller 'DOWN' reply notifications and settle every remaining unanswered
-- message on any terminal loop before installing the open-loop mailbox guards.
CREATE TEMP TABLE _migrated_down_recipients AS
SELECT DISTINCT s.sender_session_id AS recipient_session_id
FROM unanswered_messages m
JOIN loops l ON l.id = m.loop_id
JOIN sessions w ON w.id = l.session_id
JOIN message_senders s ON s.message_id = m.id
JOIN sessions caller ON caller.id = s.sender_session_id AND caller.workspace_id = w.workspace_id
WHERE l.status IN (200, 413, 429, 499, 500, 504, 508)
  AND s.sender_session_id != l.session_id
  AND NOT (m.ordinal = 1 AND s.sender_session_id IS w.parent_session_id);

INSERT INTO ambient_events (
    workspace_id, producer_session_id, recipient_session_id, workspace_broadcast,
    kind, source_record_id, source, op,
    tx, mimetype_tx, rx, mimetype_rx, status_rx, state, attrs
)
SELECT w.workspace_id, l.session_id, s.sender_session_id, 0,
       'reply', l.id, NULL, 'fail',
       json_object(
           'op', 'fail',
           'target', m.key_path,
           'body', 'Loop ' || l.sequence || ' ended with status '
               || COALESCE(json_extract(l.terminal_result, '$.status'), l.status)
               || '; this message was not answered.'
       ),
       'application/json',
       json_object('status', 200, 'repliedTo', json_array(m.key_path), 'completion', 499),
       'application/json',
       200, 'resolved',
       json_object('kind', 'reply', 'messageId', m.id)
FROM unanswered_messages m
JOIN loops l ON l.id = m.loop_id
JOIN sessions w ON w.id = l.session_id
JOIN message_senders s ON s.message_id = m.id
JOIN sessions caller ON caller.id = s.sender_session_id AND caller.workspace_id = w.workspace_id
WHERE l.status IN (200, 413, 429, 499, 500, 504, 508)
  AND s.sender_session_id != l.session_id
  AND NOT (m.ordinal = 1 AND s.sender_session_id IS w.parent_session_id)
ON CONFLICT DO NOTHING;

UPDATE sessions
SET wake_revision = wake_revision + 1
WHERE id IN (SELECT recipient_session_id FROM _migrated_down_recipients);

DROP TABLE _migrated_down_recipients;

INSERT INTO message_completions (message_id, response_id, status)
SELECT u.id, NULL, 499
FROM unanswered_messages u
JOIN loops l ON l.id = u.loop_id
WHERE l.status IN (200, 413, 429, 499, 500, 504, 508)
ON CONFLICT(message_id) DO NOTHING;

-- 5. Pure baseline guards: only non-terminal incarnations may accept or receive re-homed
-- mailbox rows, and settled completions of a terminal incarnation are immutable except
-- when cascading history removal deletes the containing loop/session/workspace.
CREATE TRIGGER loop_messages_open_loop_only
BEFORE INSERT ON loop_messages
WHEN EXISTS (SELECT 1 FROM loops WHERE id = NEW.loop_id AND status NOT IN (100, 102, 202))
BEGIN
    SELECT RAISE(ABORT, 'messages may only be enqueued into an open loop');
END;

CREATE TRIGGER loop_messages_rehome_open_loop_only
BEFORE UPDATE OF loop_id ON loop_messages
WHEN EXISTS (SELECT 1 FROM loops WHERE id = NEW.loop_id AND status NOT IN (100, 102, 202))
BEGIN
    SELECT RAISE(ABORT, 'messages may only be re-homed into an open loop');
END;

CREATE TRIGGER message_completions_terminal_loop_retained
BEFORE DELETE ON message_completions
WHEN EXISTS (
    SELECT 1
    FROM loop_messages m
    JOIN loops l ON l.id = m.loop_id
    JOIN sessions w ON w.id = l.session_id
    JOIN workspaces ws ON ws.id = w.workspace_id
    WHERE m.id = OLD.message_id
      AND l.status IN (200, 413, 429, 499, 500, 504, 508)
)
BEGIN
    SELECT RAISE(ABORT, 'settled message completions of a terminal loop can only be removed with their containing history');
END;

PRAGMA foreign_key_check;

COMMIT;
PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
