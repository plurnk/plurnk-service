-- MIGRATE: 12 done fail responses
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

-- {§db-migrations} {§message-completion} {§env-delta} Include DONE and FAIL in response and ambient candidate views.
DROP VIEW IF EXISTS log_responses;
CREATE VIEW log_responses AS
SELECT le.id, le.loop_id, le.turn_id, le.session_id, le.sequence, le.source, le.origin,
       CASE WHEN json_valid(le.rx) THEN le.rx END AS rx,
       CASE WHEN json_valid(le.tx) THEN COALESCE(json_extract(le.tx, '$.body.raw'), json_extract(le.tx, '$.body'), '') END AS content
FROM log_entries le
    WHERE le.state = 'resolved'
      AND le.op IN ('SEND', 'DONE', 'FAIL', 'KILL') AND le.status_rx BETWEEN 200 AND 299
      AND le.source IS NULL AND le.inherited_history = 0
      AND json_valid(le.tx)
      AND json_type(CASE WHEN json_valid(le.rx) THEN le.rx END, '$.repliedTo') = 'array'
      AND typeof(content) = 'text';

DROP VIEW IF EXISTS ambient_activity_candidates;
CREATE VIEW ambient_activity_candidates AS
SELECT *
FROM (
    SELECT w.workspace_id,
           le.session_id AS producer_session_id,
           -- {§env-delta} — the runtime's own materialization (turn-0
           -- initialization, doc-reconciliation maintenance, operation batches) is
           -- private to the session it serves and never crosses to the parent.
           CASE
               WHEN t.producer = '_plurnk' AND t.kind IN ('operation', 'initialization', 'maintenance') THEN NULL
               WHEN EXISTS (
                   SELECT 1 FROM message_reply_deliveries d
                   WHERE d.source_record_id = le.id AND d.recipient_session_id = w.parent_session_id
               ) THEN NULL
               ELSE w.parent_session_id
           END AS recipient_session_id,
           CASE
               WHEN le.state = 'resolved'
                AND NOT (t.producer = '_plurnk' AND t.kind = 'maintenance')
                AND le.status_rx BETWEEN 200 AND 399
                AND le.status_rx != 304
                AND (
                    (
                        le.op IN ('EDIT', 'KILL')
                        AND le.scheme = 'workspace'
                        AND le.hostname IS NULL
                        AND le.pathname IS NOT NULL
                    )
                    OR (
                        le.op IN ('COPY', 'MOVE')
                        AND json_valid(le.rx)
                        AND EXISTS (
                            SELECT 1 FROM json_each(le.rx, '$.effects') effect
                            WHERE json_type(effect.value) = 'object'
                              AND substr(CAST(json_extract(effect.value, '$.target') AS TEXT), 1, 13) = 'workspace:///'
                        )
                    )
                )
               THEN 1 ELSE 0
           END AS workspace_broadcast,
           le.id AS source_record_id,
           le.at,
           le.source,
           le.op,
           le.signal,
           le.scheme,
           le.username,
           le.password,
           le.hostname,
           le.port,
           le.pathname,
           le.query,
           le.fragment,
           le.lineMarker AS line_marker,
           le.tx,
           le.mimetype_tx,
           le.rx,
           le.mimetype_rx,
           le.status_rx,
           le.state,
           le.outcome,
           json_remove(le.attrs, '$.__plurnk_curation') AS attrs
    FROM log_entries le
    JOIN sessions w ON w.id = le.session_id
    JOIN turns t ON t.id = le.turn_id
    WHERE le.ambient_event_id IS NULL
      AND le.inherited_history = 0
      AND COALESCE(json_extract(le.attrs, '$.kind'), '') != 'message'
      AND (
          le.op IN ('EDIT', 'COPY', 'MOVE', 'WORK', 'FORK')
          OR (le.op IN ('SEND', 'DONE', 'FAIL') AND (
              le.status_rx >= 400
              OR json_extract(CASE WHEN json_valid(le.tx) THEN le.tx END, '$.target') IS NOT NULL
              OR json_type(CASE WHEN json_valid(le.rx) THEN le.rx END, '$.repliedTo') = 'array'
          ))
          OR CASE WHEN json_valid(le.tx) THEN json_type(le.tx, '$.runtime') END = 'text'
          OR (le.op = 'KILL' AND COALESCE(le.scheme, 'file') != 'log'
              AND json_extract(CASE WHEN json_valid(le.tx) THEN le.tx END, '$.target') IS NOT NULL)
      )
      AND le.state != 'proposed'
) candidate
WHERE recipient_session_id IS NOT NULL OR workspace_broadcast = 1;
