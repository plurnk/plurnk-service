-- MIGRATE: 20 transient notices
-- {§db-migrations} {§log-history-projection} {§operation-results} {§env-delta} Add loop notice log cursor, durable loop_notices, resolved 2xx/3xx child activity filtering, and inactive projection backfill for stateless refusals and zero-match/unchanged mutations.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 5.0.0 support floor (schema version 11); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

-- 1. Monotonic per-loop log notice cursor; pre-existing history on upgraded loops starts acknowledged
-- up to any unresolved proposed row.
ALTER TABLE loops ADD COLUMN notice_log_cursor INTEGER NOT NULL DEFAULT 0 CHECK (notice_log_cursor >= 0);

UPDATE loops
SET notice_log_cursor = COALESCE((
    SELECT MAX(r.id)
    FROM log_entry_rows r
    WHERE r.loop_id = loops.id
      AND r.id <= COALESCE((
          SELECT MIN(p.id) - 1
          FROM log_entry_rows p
          WHERE p.loop_id = loops.id AND p.state = 'proposed'
      ), 9223372036854775807)
), 0);

-- 2. Durable loop-scoped notices so unacknowledged NoticeChannel state survives restarts across parked loops.
CREATE TABLE loop_notices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    loop_id         INTEGER NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
    replacement_key TEXT    CHECK (replacement_key IS NULL OR length(replacement_key) > 0),
    notice          TEXT    NOT NULL CHECK (json_valid(notice) AND json_type(notice) = 'object')
) STRICT;

CREATE UNIQUE INDEX loop_notices_replacement_key
    ON loop_notices (loop_id, replacement_key) WHERE replacement_key IS NOT NULL;

CREATE INDEX loop_notices_loop_id
    ON loop_notices (loop_id);

-- 3. Restrict direct child activity deltas to settled 2xx/3xx (excluding 204 and 304) occurrences;
-- child failures reach the parent via loop_termination.
DROP VIEW IF EXISTS ambient_activity_candidates;
CREATE VIEW ambient_activity_candidates AS
SELECT *
FROM (
    SELECT w.workspace_id,
           le.session_id AS producer_session_id,
           CASE
               WHEN NOT (
                   le.state = 'resolved'
                   AND le.status_rx BETWEEN 200 AND 399
                   AND le.status_rx NOT IN (204, 304)
               ) THEN NULL
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
                AND le.status_rx NOT IN (204, 304)
                AND (
                    (
                        le.op IN ('edit', 'kill')
                        AND le.scheme = 'workspace'
                        AND le.hostname IS NULL
                        AND le.pathname IS NOT NULL
                    )
                    OR (
                        le.op IN ('copy', 'move')
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
      AND le.state = 'resolved'
      AND le.status_rx BETWEEN 200 AND 399
      AND le.status_rx NOT IN (204, 304)
      AND COALESCE(json_extract(le.attrs, '$.kind'), '') != 'message'
      AND (
          le.op IN ('edit', 'copy', 'move', 'work', 'fork')
          OR (le.op IN ('send', 'done', 'fail') AND (
              json_extract(CASE WHEN json_valid(le.tx) THEN le.tx END, '$.target') IS NOT NULL
              OR json_type(CASE WHEN json_valid(le.rx) THEN le.rx END, '$.repliedTo') = 'array'
          ))
          OR CASE WHEN json_valid(le.tx) THEN json_type(le.tx, '$.runtime') END = 'text'
          OR (le.op = 'kill' AND COALESCE(le.scheme, 'file') != 'log'
              AND json_extract(CASE WHEN json_valid(le.tx) THEN le.tx END, '$.target') IS NOT NULL)
      )
) candidate
WHERE recipient_session_id IS NOT NULL OR workspace_broadcast = 1;

-- 4. Retire pre-existing stateless refusals and 204/304 mutation no-ops from active_log_entries.
UPDATE log_entry_projections
SET active = 0
WHERE active = 1
  AND log_entry_id IN (
      SELECT r.id
      FROM log_entry_rows r
      JOIN turns t ON t.id = r.turn_id
      LEFT JOIN contents c ON c.id = r.rx_content_id
      WHERE r.state != 'proposed'
        AND NOT (
            CASE
                WHEN r.status_rx < 400 THEN CASE
                    WHEN t.producer = '_plurnk' AND t.kind = 'maintenance' AND r.source IS NULL THEN 1
                    WHEN r.status_rx = 304 THEN 0
                    WHEN r.status_rx = 204 AND COALESCE(r.op, '') NOT IN ('find', 'read') THEN 0
                    ELSE 1
                END
                ELSE CASE
                    WHEN r.subscription_publication_id IS NOT NULL THEN 1
                    WHEN r.origin = '_plurnk' AND r.ambient_event_id IS NOT NULL THEN 1
                    WHEN COALESCE(r.outcome, '') = 'owner_vanished' THEN 1
                    WHEN COALESCE(r.op, '') = 'read'
                     AND COALESCE(r.scheme, '') IN ('session', 'ops')
                     AND r.status_rx NOT IN (400, 404, 416, 425, 503) THEN 1
                    WHEN r.mimetype_rx != 'application/json' THEN 1
                    WHEN c.content IS NOT NULL
                     AND json_valid(CAST(c.content AS TEXT))
                     AND (
                         (
                             json_type(CAST(c.content AS TEXT), '$.content') = 'text'
                             AND length(json_extract(CAST(c.content AS TEXT), '$.content')) > 0
                         )
                         OR (
                             json_type(CAST(c.content AS TEXT), '$.effects') = 'array'
                             AND json_array_length(CAST(c.content AS TEXT), '$.effects') > 0
                         )
                         OR CAST(COALESCE(json_extract(CAST(c.content AS TEXT), '$.problem.delivered'), 0) AS INTEGER) > 0
                         OR json_extract(CAST(c.content AS TEXT), '$.problem.published') = 1
                         OR json_extract(CAST(c.content AS TEXT), '$.problem.deleted') = 1
                         OR json_extract(CAST(c.content AS TEXT), '$.problem.committed') = 1
                         OR json_extract(CAST(c.content AS TEXT), '$.problem.destinationWritten') = 1
                         OR json_extract(CAST(c.content AS TEXT), '$.problem.type') IN (
                             'https://problems.plurnk.xyz/scheme/file/materialization-failed',
                             'https://problems.plurnk.xyz/scheme/file/creation-rollback-failed'
                         )
                     ) THEN 1
                    ELSE 0
                END
            END = 1
        )
  );
