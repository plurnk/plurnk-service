-- MIGRATE: 21 curation floor
-- {§db-migrations} {§tokenomics} {§packet} Admit zero curatable room on turns.usage_curation_budget and optional curatable log weight $.curationWeight on turns.packet (#1476).
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 5.0.0 support floor (schema version 11); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

DROP TRIGGER IF EXISTS turns_identity_forward_only;

COMMIT;
PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;
BEGIN IMMEDIATE;

CREATE TABLE turns_new (
    id               INTEGER NOT NULL PRIMARY KEY,
    loop_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL           CHECK (sequence >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    producer         TEXT    NOT NULL           CHECK (producer IN ('model', 'client', '_plurnk', 'plugin')),
    kind             TEXT    NOT NULL           CHECK (kind IN ('inference', 'initialization', 'operation', 'maintenance')),
    status           INTEGER NOT NULL           CHECK (status BETWEEN 100 AND 599),
    completed_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    usage_curation_budget INTEGER                CHECK (usage_curation_budget IS NULL OR usage_curation_budget >= 0),
    packet           TEXT                       CHECK (
        CASE
            WHEN packet IS NULL THEN 1
            WHEN json_valid(packet) = 0 THEN 0
            ELSE COALESCE(
                json_type(packet) = 'object'
                AND json_type(packet, '$.weight') = 'integer'
                AND json_extract(packet, '$.weight') >= 0
                AND (
                    json_type(packet, '$.curationWeight') IS NULL
                    OR (
                        json_type(packet, '$.curationWeight') = 'integer'
                        AND json_extract(packet, '$.curationWeight') >= 0
                        AND json_extract(packet, '$.curationWeight') <= json_extract(packet, '$.weight')
                    )
                )
                AND json_type(packet, '$.sections') IS NULL
                AND json_type(packet, '$.attributions') = 'array'
                AND (
                    (
                        json_type(packet, '$.assistant') IS NULL
                        AND json_type(packet, '$.assistantRaw') IS NULL
                    )
                    OR (
                        json_type(packet, '$.assistant') = 'object'
                        AND json_type(packet, '$.assistant.content') = 'text'
                        AND json_type(packet, '$.assistant.ops') = 'array'
                        AND json_type(packet, '$.assistant.reasoning') IN ('text', 'null')
                        AND json_type(packet, '$.assistantRaw') IS NOT NULL
                    )
                ),
                0
            )
        END
    ),
    finish_reason    TEXT,
    model            TEXT                       CHECK (model IS NULL OR length(model) >= 1),
    meta             TEXT                       CHECK (meta IS NULL OR json_valid(meta)),
    CHECK (completed_at IS NOT NULL OR status = 102),
    CHECK ((producer = 'model') = (kind = 'inference')),
    CHECK (kind NOT IN ('initialization', 'maintenance') OR producer = '_plurnk'),
    CHECK (
        kind = 'inference'
        OR (
            usage_curation_budget IS NULL
            AND packet IS NULL
            AND finish_reason IS NULL
            AND model IS NULL
            AND meta IS NULL
        )
    ),
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
) STRICT;

INSERT INTO turns_new (
    id, loop_id, sequence, timestamp, producer, kind, status, completed_at,
    usage_curation_budget, packet, finish_reason, model, meta
)
SELECT
    id, loop_id, sequence, timestamp, producer, kind, status, completed_at,
    usage_curation_budget, packet, finish_reason, model, meta
FROM turns;

DROP TABLE turns;
ALTER TABLE turns_new RENAME TO turns;

CREATE UNIQUE INDEX turns_loop_id_sequence ON turns (loop_id, sequence);

CREATE TRIGGER turns_identity_forward_only
BEFORE UPDATE OF producer, kind ON turns
WHEN NOT (
    OLD.producer = NEW.producer
    AND OLD.kind = NEW.kind
)
BEGIN
    SELECT RAISE(ABORT, 'turn producer and kind are immutable');
END;

PRAGMA foreign_key_check;
COMMIT;
PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
