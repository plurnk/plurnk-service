-- MIGRATE: 25 retire stateless log projections
-- {§db-migrations} {§log-history-projection} {§emission-history} Retire 200 log:/// curations, 204/304 mutation no-ops, and stateless >=400 refusals from active_log_entries.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 5.0.0 support floor (schema version 11); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

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
                    WHEN COALESCE(r.op, '') = 'kill' AND COALESCE(r.scheme, '') = 'log' AND r.status_rx = 200 THEN 0
                    WHEN r.status_rx = 304 THEN 0
                    WHEN r.status_rx = 204 AND COALESCE(r.op, '') NOT IN ('find', 'read') THEN 0
                    ELSE 1
                END
                ELSE CASE
                    WHEN r.subscription_publication_id IS NOT NULL THEN CASE
                        WHEN COALESCE(r.scheme, '') = 'plurnk' AND r.status_rx != 499 THEN 0
                        WHEN c.content IS NOT NULL
                         AND json_valid(CAST(c.content AS TEXT))
                         AND json_extract(CAST(c.content AS TEXT), '$.problem.type') = 'https://problems.plurnk.xyz/executor/mcp/tool-header-invalid' THEN 0
                        WHEN r.status_rx >= 499 THEN 1
                        WHEN r.mimetype_rx != 'application/json' THEN 1
                        WHEN c.content IS NOT NULL
                         AND json_valid(CAST(c.content AS TEXT))
                         AND (
                             json_type(CAST(c.content AS TEXT), '$.exitCode') IS NOT NULL
                             OR (
                                 json_type(CAST(c.content AS TEXT), '$.content') = 'text'
                                 AND length(json_extract(CAST(c.content AS TEXT), '$.content')) > 0
                             )
                             OR (
                                 json_type(CAST(c.content AS TEXT), '$.effects') = 'array'
                                 AND json_array_length(CAST(c.content AS TEXT), '$.effects') > 0
                             )
                         ) THEN 1
                        ELSE 0
                    END
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
