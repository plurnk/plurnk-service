-- MIGRATE: 14 lowercase ops
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

-- {§db-migrations} {§op-methods-op-dispatch} {§env-delta} Lowercase the 15 core operation tokens across schema constraints, triggers, views, and persisted rows.
DROP VIEW IF EXISTS unobserved_session_completions;
DROP TRIGGER IF EXISTS ambient_child_wake_revision;
DROP TRIGGER IF EXISTS log_entries_deliver_replies;
DROP TRIGGER IF EXISTS sessions_capture_ambient_baseline;
DROP TRIGGER IF EXISTS loops_append_ambient_event;
DROP TRIGGER IF EXISTS log_entries_append_ambient_event_insert;
DROP TRIGGER IF EXISTS log_entries_append_ambient_event_resolve;
DROP TRIGGER IF EXISTS ambient_events_retire_log_refs;
DROP TRIGGER IF EXISTS log_entries_ambient_event_once;
DROP TRIGGER IF EXISTS log_entries_immutable_core;
DROP TRIGGER IF EXISTS log_entries_immutable_attrs;
DROP TRIGGER IF EXISTS log_entries_emission_frozen;

CREATE TEMP TABLE _ambient_event_links AS
SELECT id, ambient_event_id FROM log_entries WHERE ambient_event_id IS NOT NULL;

UPDATE log_entries SET ambient_event_id = NULL WHERE ambient_event_id IS NOT NULL;

DROP TRIGGER IF EXISTS ambient_events_structural_audience;
DROP INDEX IF EXISTS ambient_events_workspace_id_id;
DROP INDEX IF EXISTS ambient_events_producer_kind_id;
DROP INDEX IF EXISTS ambient_events_parent_id;
DROP INDEX IF EXISTS ambient_events_source_identity;
DROP INDEX IF EXISTS ambient_reply_recipient;

CREATE TABLE ambient_events_new (
    id                      INTEGER NOT NULL PRIMARY KEY,
    workspace_id            INTEGER NOT NULL,
    producer_session_id     INTEGER NOT NULL,
    recipient_session_id    INTEGER,
    workspace_broadcast     INTEGER NOT NULL DEFAULT 0 CHECK (workspace_broadcast IN (0, 1)),
    kind                    TEXT    NOT NULL CHECK (kind IN ('activity', 'loop_termination', 'reply')),
    source_record_id        INTEGER NOT NULL CHECK (source_record_id >= 1),
    at                      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    source                  TEXT,
    op                      TEXT    NOT NULL,
    signal                  TEXT             CHECK (signal IS NULL OR json_valid(signal)),
    scheme                  TEXT,
    username                TEXT,
    password                TEXT,
    hostname                TEXT,
    port                    INTEGER          CHECK (port IS NULL OR (port BETWEEN 0 AND 65535)),
    pathname                TEXT,
    query                   TEXT,
    fragment                TEXT,
    line_marker             TEXT             CHECK (line_marker IS NULL OR json_valid(line_marker)),
    tx                      TEXT    NOT NULL,
    mimetype_tx             TEXT    NOT NULL CHECK (length(mimetype_tx) > 0),
    rx                      TEXT    NOT NULL,
    mimetype_rx             TEXT    NOT NULL CHECK (length(mimetype_rx) > 0),
    status_rx               INTEGER NOT NULL CHECK (status_rx BETWEEN 100 AND 599),
    state                   TEXT    NOT NULL CHECK (state IN ('resolved', 'failed', 'cancelled')),
    outcome                 TEXT,
    attrs                   TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
    terminated_by           TEXT             CHECK (terminated_by IS NULL OR terminated_by = 'cancel'),
    CHECK (recipient_session_id IS NOT NULL OR workspace_broadcast = 1),
    CHECK (
        (kind IN ('activity', 'reply') AND terminated_by IS NULL)
        OR
        (kind = 'loop_termination'
            AND op = 'read'
            -- {§env-delta}: the exact concluded loop is a resource, not a message;
            -- {§message-completion} names it at the child's own loop address.
            AND scheme = 'ops'
            AND hostname IS NOT NULL
            AND pathname IS NOT NULL
            AND query IS NULL
            AND json_valid(rx)
            AND json_type(rx) = 'object'
            AND json_type(rx, '$.status') = 'integer'
            AND json_extract(rx, '$.status') = status_rx)
    ),
    FOREIGN KEY (workspace_id)         REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (producer_session_id)  REFERENCES sessions(id)   ON DELETE CASCADE,
    FOREIGN KEY (recipient_session_id) REFERENCES sessions(id)   ON DELETE CASCADE
) STRICT;

INSERT INTO ambient_events_new (
    id, workspace_id, producer_session_id, recipient_session_id, workspace_broadcast,
    kind, source_record_id, at, source, op, signal, scheme, username, password,
    hostname, port, pathname, query, fragment, line_marker, tx, mimetype_tx,
    rx, mimetype_rx, status_rx, state, outcome, attrs, terminated_by
)
SELECT
    id, workspace_id, producer_session_id, recipient_session_id, workspace_broadcast,
    kind, source_record_id, at,
    CASE
        WHEN source GLOB 'log:///*[A-Z]*'
        THEN lower(source)
        ELSE source
    END,
    CASE
        WHEN op IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
        THEN lower(op)
        ELSE op
    END,
    signal, scheme, username, password,
    hostname, port,
    CASE
        WHEN scheme = 'log' AND pathname GLOB '*[A-Z]*'
        THEN lower(pathname)
        ELSE pathname
    END,
    query, fragment, line_marker,
    CASE
        WHEN json_valid(tx)
         AND json_extract(tx, '$.op') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
        THEN json_set(
            CASE
                WHEN json_extract(tx, '$.target.raw') GLOB 'log:///*[A-Z]*'
                THEN json_set(
                    tx,
                    '$.target.raw', lower(json_extract(tx, '$.target.raw')),
                    '$.target.pathname', lower(json_extract(tx, '$.target.pathname'))
                )
                ELSE tx
            END,
            '$.op',
            lower(json_extract(tx, '$.op'))
        )
        WHEN json_valid(tx)
         AND json_extract(tx, '$.target.raw') GLOB 'log:///*[A-Z]*'
        THEN json_set(
            tx,
            '$.target.raw', lower(json_extract(tx, '$.target.raw')),
            '$.target.pathname', lower(json_extract(tx, '$.target.pathname'))
        )
        ELSE tx
    END,
    mimetype_tx,
    CASE
        WHEN json_valid(rx)
         AND json_extract(rx, '$.problem.instance') GLOB 'log:///*[A-Z]*'
        THEN json_set(rx, '$.problem.instance', lower(json_extract(rx, '$.problem.instance')))
        WHEN json_valid(rx)
         AND json_extract(rx, '$.attrs.distilled') GLOB '*[A-Z]*'
        THEN json_set(rx, '$.attrs.distilled', lower(json_extract(rx, '$.attrs.distilled')))
        ELSE rx
    END,
    mimetype_rx, status_rx, state, outcome,
    CASE
        WHEN json_valid(attrs)
         AND json_extract(attrs, '$.distilled') GLOB '*[A-Z]*'
        THEN json_set(attrs, '$.distilled', lower(json_extract(attrs, '$.distilled')))
        ELSE attrs
    END,
    terminated_by
FROM ambient_events;

DROP TABLE ambient_events;
ALTER TABLE ambient_events_new RENAME TO ambient_events;

CREATE INDEX ambient_events_workspace_id_id
    ON ambient_events (workspace_id, id);

-- {§db-migrations} Producer deletion's foreign-key check walks its events by producer; no registry statement selects by it.
CREATE INDEX ambient_events_producer_kind_id
    ON ambient_events (producer_session_id, kind, id);

CREATE INDEX ambient_events_parent_id
    ON ambient_events (recipient_session_id, id)
    WHERE recipient_session_id IS NOT NULL;

CREATE UNIQUE INDEX ambient_events_source_identity
    ON ambient_events (producer_session_id, kind, source_record_id) WHERE kind != 'reply';

CREATE UNIQUE INDEX ambient_reply_recipient
    ON ambient_events (source_record_id, recipient_session_id) WHERE kind = 'reply';

CREATE TRIGGER ambient_events_structural_audience
BEFORE INSERT ON ambient_events
WHEN NOT EXISTS (
    SELECT 1
    FROM sessions producer
    WHERE producer.id = NEW.producer_session_id
      AND producer.workspace_id = NEW.workspace_id
      AND (
          NEW.recipient_session_id IS NULL
          OR NEW.recipient_session_id = producer.parent_session_id
          OR (NEW.kind = 'reply' AND EXISTS (
              SELECT 1 FROM sessions recipient WHERE recipient.id = NEW.recipient_session_id
                AND recipient.workspace_id = NEW.workspace_id
          ))
      )
)
BEGIN
    SELECT RAISE(ABORT, 'ambient event audience must be in the producer workspace; non-reply recipients must be its direct parent');
END;

UPDATE log_entries
SET ambient_event_id = (SELECT ambient_event_id FROM _ambient_event_links WHERE _ambient_event_links.id = log_entries.id)
WHERE EXISTS (SELECT 1 FROM _ambient_event_links WHERE _ambient_event_links.id = log_entries.id);

DROP TABLE _ambient_event_links;

UPDATE log_entries
SET op = CASE
        WHEN op IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
        THEN lower(op)
        ELSE op
    END,
    pathname = CASE
        WHEN scheme = 'log'
         AND pathname GLOB '*[A-Z]*'
        THEN lower(pathname)
        ELSE pathname
    END,
    tx = CASE
        WHEN json_valid(tx)
         AND json_extract(tx, '$.op') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
        THEN json_set(
            CASE
                WHEN json_extract(tx, '$.target.raw') GLOB 'log:///*[A-Z]*'
                THEN json_set(
                    tx,
                    '$.target.raw', lower(json_extract(tx, '$.target.raw')),
                    '$.target.pathname', lower(json_extract(tx, '$.target.pathname'))
                )
                ELSE tx
            END,
            '$.op',
            lower(json_extract(tx, '$.op'))
        )
        WHEN json_valid(tx)
         AND json_extract(tx, '$.target.raw') GLOB 'log:///*[A-Z]*'
        THEN json_set(
            tx,
            '$.target.raw', lower(json_extract(tx, '$.target.raw')),
            '$.target.pathname', lower(json_extract(tx, '$.target.pathname'))
        )
        ELSE tx
    END,
    rx = CASE
        WHEN json_valid(rx)
         AND json_extract(rx, '$.problem.instance') GLOB 'log:///*[A-Z]*'
        THEN json_set(
            rx,
            '$.problem.instance',
            lower(json_extract(rx, '$.problem.instance'))
        )
        WHEN json_valid(rx)
         AND json_extract(rx, '$.attrs.distilled') GLOB '*[A-Z]*'
        THEN json_set(
            rx,
            '$.attrs.distilled',
            lower(json_extract(rx, '$.attrs.distilled'))
        )
        ELSE rx
    END,
    attrs = CASE
        WHEN json_valid(attrs)
         AND json_extract(attrs, '$.distilled') GLOB '*[A-Z]*'
        THEN json_set(
            attrs,
            '$.distilled',
            lower(json_extract(attrs, '$.distilled'))
        )
        ELSE attrs
    END,
    source = CASE
        WHEN source GLOB 'log:///*[A-Z]*'
        THEN lower(source)
        ELSE source
    END
WHERE op IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
   OR (scheme = 'log' AND pathname GLOB '*[A-Z]*')
   OR (json_valid(tx) AND (json_extract(tx, '$.op') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT') OR json_extract(tx, '$.target.raw') GLOB 'log:///*[A-Z]*'))
   OR (json_valid(rx) AND (json_extract(rx, '$.problem.instance') GLOB 'log:///*[A-Z]*' OR json_extract(rx, '$.attrs.distilled') GLOB '*[A-Z]*'))
   OR (json_valid(attrs) AND json_extract(attrs, '$.distilled') GLOB '*[A-Z]*')
   OR (source GLOB 'log:///*[A-Z]*');

CREATE TRIGGER log_entries_immutable_core
BEFORE UPDATE OF
    session_id, loop_id, turn_id, sequence, at, origin, source, inherited_history, model_call_id,
    op, signal,
    scheme, username, password, hostname,
    port, pathname, query, fragment,
    lineMarker, tx, mimetype_tx, mimetype_rx, initial_folded
ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only lifecycle outcome and derived attachments may change');
END;

CREATE TRIGGER log_entries_immutable_attrs
BEFORE UPDATE OF attrs ON log_entries
WHEN COALESCE((
    json_type(OLD.attrs, '$.__plurnk_curation') = 'object'
    AND NEW.attrs = json_remove(OLD.attrs, '$.__plurnk_curation')
), 0) = 0
BEGIN
    SELECT RAISE(ABORT, 'log_entries attrs are immutable outside curation payload removal');
END;

CREATE TRIGGER log_entries_emission_frozen
BEFORE UPDATE OF rx, status_rx, state, outcome, weight ON log_entries
WHEN json_extract(OLD.attrs, '$.kind') = 'emission'
BEGIN
    SELECT RAISE(ABORT, 'an emission row is frozen');
END;

CREATE TRIGGER log_entries_ambient_event_once
BEFORE UPDATE OF ambient_event_id ON log_entries
WHEN NOT (
    (OLD.ambient_event_id IS NULL AND NEW.ambient_event_id IS NOT NULL)
    OR (NEW.ambient_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM ambient_events WHERE id = OLD.ambient_event_id))
)
BEGIN
    SELECT RAISE(ABORT, 'log_entries ambient event identity may only be assigned once');
END;

UPDATE turns
SET packet = json_set(
    packet,
    '$.assistant.ops',
    (
        SELECT json_group_array(
            CASE
                WHEN json_type(item.value) = 'object'
                 AND json_extract(item.value, '$.op') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
                THEN json(
                    json_set(
                        CASE
                            WHEN json_extract(item.value, '$.target.raw') GLOB 'log:///*[A-Z]*'
                            THEN json_set(
                                item.value,
                                '$.target.raw', lower(json_extract(item.value, '$.target.raw')),
                                '$.target.pathname', lower(json_extract(item.value, '$.target.pathname'))
                            )
                            ELSE item.value
                        END,
                        '$.op',
                        lower(json_extract(item.value, '$.op'))
                    )
                )
                WHEN json_type(item.value) = 'object'
                 AND json_extract(item.value, '$.target.raw') GLOB 'log:///*[A-Z]*'
                THEN json(
                    json_set(
                        item.value,
                        '$.target.raw', lower(json_extract(item.value, '$.target.raw')),
                        '$.target.pathname', lower(json_extract(item.value, '$.target.pathname'))
                    )
                )
                ELSE json(item.value)
            END
        )
        FROM json_each(turns.packet, '$.assistant.ops') item
    )
)
WHERE packet IS NOT NULL
  AND json_valid(packet)
  AND json_type(packet, '$.assistant.ops') = 'array'
  AND EXISTS (
      SELECT 1
      FROM json_each(turns.packet, '$.assistant.ops') item
      WHERE json_type(item.value) = 'object'
        AND (
            json_extract(item.value, '$.op') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
            OR json_extract(item.value, '$.target.raw') GLOB 'log:///*[A-Z]*'
        )
  );

UPDATE workspaces
SET settings = json_set(
    settings,
    '$.capabilities.allow',
    (
        SELECT json_group_array(
            CASE
                WHEN json_type(item.value) = 'object'
                 AND json_extract(item.value, '$.operation') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
                THEN json_set(item.value, '$.operation', lower(json_extract(item.value, '$.operation')))
                ELSE json(item.value)
            END
        )
        FROM json_each(workspaces.settings, '$.capabilities.allow') item
    )
)
WHERE json_valid(settings)
  AND json_type(settings, '$.capabilities.allow') = 'array'
  AND EXISTS (
      SELECT 1
      FROM json_each(workspaces.settings, '$.capabilities.allow') item
      WHERE json_type(item.value) = 'object'
        AND json_extract(item.value, '$.operation') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
  );

UPDATE workspaces
SET settings = json_set(
    settings,
    '$.capabilities.only',
    (
        SELECT json_group_array(
            CASE
                WHEN json_type(item.value) = 'object'
                 AND json_extract(item.value, '$.operation') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
                THEN json_set(item.value, '$.operation', lower(json_extract(item.value, '$.operation')))
                ELSE json(item.value)
            END
        )
        FROM json_each(workspaces.settings, '$.capabilities.only') item
    )
)
WHERE json_valid(settings)
  AND json_type(settings, '$.capabilities.only') = 'array'
  AND EXISTS (
      SELECT 1
      FROM json_each(workspaces.settings, '$.capabilities.only') item
      WHERE json_type(item.value) = 'object'
        AND json_extract(item.value, '$.operation') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
  );

UPDATE workspaces
SET settings = json_set(
    settings,
    '$.capabilities.deny',
    (
        SELECT json_group_array(
            CASE
                WHEN json_type(item.value) = 'object'
                 AND json_extract(item.value, '$.operation') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
                THEN json_set(item.value, '$.operation', lower(json_extract(item.value, '$.operation')))
                ELSE json(item.value)
            END
        )
        FROM json_each(workspaces.settings, '$.capabilities.deny') item
    )
)
WHERE json_valid(settings)
  AND json_type(settings, '$.capabilities.deny') = 'array'
  AND EXISTS (
      SELECT 1
      FROM json_each(workspaces.settings, '$.capabilities.deny') item
      WHERE json_type(item.value) = 'object'
        AND json_extract(item.value, '$.operation') IN ('FIND','READ','EDIT','COPY','MOVE','SEND','DONE','FAIL','BARE','WORK','FORK','KILL','NOTE','TODO','WAIT')
  );

DROP TRIGGER IF EXISTS model_calls_native_inputs_valid;
CREATE TRIGGER model_calls_native_inputs_valid
BEFORE UPDATE OF native_inputs ON model_calls
WHEN (
    SELECT COUNT(*) != COUNT(DISTINCT value)
        OR SUM(CASE WHEN type != 'text' OR length(value) = 0 THEN 1 ELSE 0 END) > 0
    FROM json_each(NEW.native_inputs)
)
OR EXISTS (
    SELECT 1
    FROM json_each(NEW.native_inputs) native
    WHERE NOT EXISTS (
        SELECT 1
        FROM inference_calls call
        JOIN turns request_turn ON request_turn.id = call.turn_id
        JOIN loops request_loop ON request_loop.id = request_turn.loop_id
        JOIN log_entries entry ON entry.session_id = request_loop.session_id
        JOIN turns entry_turn ON entry_turn.id = entry.turn_id
        JOIN loops entry_loop ON entry_loop.id = entry_turn.loop_id
        WHERE call.id = NEW.id
          AND entry.op = 'read'
          AND entry.status_rx < 400
          AND (entry_loop.sequence || '/' || entry_turn.sequence || '/' || entry.sequence) = native.value
    )
)
BEGIN
    SELECT RAISE(ABORT, 'model call native inputs must be unique successful read coordinates owned by its session');
END;

DROP TRIGGER IF EXISTS log_entries_emission_shape;
CREATE TRIGGER log_entries_emission_shape
BEFORE INSERT ON log_entries
WHEN json_extract(NEW.attrs, '$.kind') = 'emission'
  AND NOT COALESCE((
      NEW.op = 'read'
      AND NEW.origin = '_plurnk'
      AND NEW.source IS NULL
      AND NEW.model_call_id IS NULL
      AND NEW.lineMarker IS NULL
      AND NEW.scheme = 'ops'
      AND NEW.status_rx = 200
      AND NEW.state = 'resolved'
      AND NEW.mimetype_rx = 'application/json'
      AND json(NEW.initial_folded) = json('[[1,-1]]')
      AND json_type(NEW.rx, '$.content') = 'text'
      AND length(json_extract(NEW.rx, '$.content')) > 0
      AND NEW.pathname = (
          SELECT '/' || l.sequence || '/' || t.sequence
          FROM turns t JOIN loops l ON l.id = t.loop_id
          WHERE t.id = NEW.turn_id
      )
      AND (SELECT kind FROM turns WHERE id = NEW.turn_id) IN ('inference', 'initialization')
      AND EXISTS (
          SELECT 1 FROM turn_sources
          WHERE turn_id = NEW.turn_id AND kind = 'ops' AND sequence = 0
      )
      AND NOT EXISTS (
          SELECT 1 FROM log_entries
          WHERE turn_id = NEW.turn_id AND sequence > NEW.sequence
      )
      AND (
          NEW.inherited_history = 1
          OR NEW.hostname = (SELECT name FROM sessions WHERE id = NEW.session_id)
      )
  ), 0)
BEGIN
    SELECT RAISE(ABORT, 'an emission row is one born-folded _plurnk announcement of its own turn''s admitted ops source');
END;

DROP TRIGGER IF EXISTS log_entries_model_call_valid;
CREATE TRIGGER log_entries_model_call_valid
BEFORE INSERT ON log_entries
WHEN NEW.model_call_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM model_calls call
    JOIN inference_calls inference ON inference.id = call.id
    WHERE call.id = NEW.model_call_id
      AND inference.turn_id = NEW.turn_id
      AND inference.state != 'pending'
      AND (
          (inference.kind = 'bare' AND NEW.op = 'bare')
          OR (
              inference.kind = 'emission'
              AND NEW.op IS NULL
              AND json_extract(NEW.attrs, '$.kind') = 'emissionAttempt'
          )
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'log entry model call does not match its represented result');
END;

DROP TRIGGER IF EXISTS log_curation_effects_valid;
CREATE TRIGGER log_curation_effects_valid
BEFORE INSERT ON log_curation_effects
BEGIN
    SELECT CASE WHEN
        NOT EXISTS (
            SELECT 1
            FROM log_entries operation
            JOIN log_entries target ON target.id = NEW.target_log_entry_id
            WHERE operation.id = NEW.operation_log_entry_id
              AND operation.op = 'kill'
              AND operation.status_rx < 400
              AND operation.session_id = target.session_id
        )
        OR NOT EXISTS (
            -- {§log-kill-scope} — a scoped kill keeps the row active and changes its visibility;
            -- a whole kill retires it with its visibility untouched.
            SELECT 1
            FROM log_entries operation
            WHERE operation.id = NEW.operation_log_entry_id
              AND operation.op = 'kill'
              AND operation.scheme = 'log'
              AND NEW.active_before = 1
              AND (
                  NEW.active_after = 1
                  OR (
                      NEW.active_after = 0
                      AND json(NEW.folded_before) = json(NEW.folded_after)
                  )
              )
        )
        OR EXISTS (
            SELECT 1
            FROM (
                SELECT 'before' AS side, key, value, type FROM json_each(NEW.folded_before)
                UNION ALL
                SELECT 'after' AS side, key, value, type FROM json_each(NEW.folded_after)
            ) range
            WHERE range.type != 'array'
               OR json_array_length(range.value) != 2
               OR COALESCE(json_type(range.value, '$[0]'), '') != 'integer'
               OR COALESCE(json_type(range.value, '$[1]'), '') != 'integer'
               OR json_extract(range.value, '$[0]') < 1
               OR (
                   json_extract(range.value, '$[1]') != -1
                   AND json_extract(range.value, '$[1]') < json_extract(range.value, '$[0]')
               )
               OR EXISTS (
                   SELECT 1
                   FROM (
                       SELECT key, value FROM json_each(
                           CASE range.side
                               WHEN 'before' THEN NEW.folded_before
                               ELSE NEW.folded_after
                           END
                       )
                   ) previous
                   WHERE previous.key = range.key - 1
                     AND (
                         json_extract(previous.value, '$[1]') = -1
                         OR json_extract(range.value, '$[0]') <= json_extract(previous.value, '$[1]') + 1
                     )
               )
        )
    THEN RAISE(ABORT, 'invalid log curation effect') END;
END;

DROP TRIGGER IF EXISTS log_entries_curation_payload_valid;
CREATE TRIGGER log_entries_curation_payload_valid
BEFORE INSERT ON log_entries
WHEN json_type(NEW.attrs, '$.__plurnk_curation') IS NOT NULL
 AND NOT (
    NEW.op = 'kill'
    AND NEW.status_rx < 400
    AND NEW.scheme = 'log'
    AND json_type(NEW.attrs, '$.__plurnk_curation') = 'object'
 )
BEGIN
    SELECT RAISE(ABORT, 'private log curation payload requires a successful log curation row');
END;

DROP VIEW IF EXISTS log_responses;
CREATE VIEW log_responses AS
SELECT le.id, le.loop_id, le.turn_id, le.session_id, le.sequence, le.source, le.origin,
       CASE WHEN json_valid(le.rx) THEN le.rx END AS rx,
       CASE WHEN json_valid(le.tx) THEN COALESCE(json_extract(le.tx, '$.body.raw'), json_extract(le.tx, '$.body'), '') END AS content
FROM log_entries le
    WHERE le.state = 'resolved'
      AND le.op IN ('send', 'done', 'fail', 'kill') AND le.status_rx BETWEEN 200 AND 299
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
      AND COALESCE(json_extract(le.attrs, '$.kind'), '') != 'message'
      AND (
          le.op IN ('edit', 'copy', 'move', 'work', 'fork')
          OR (le.op IN ('send', 'done', 'fail') AND (
              le.status_rx >= 400
              OR json_extract(CASE WHEN json_valid(le.tx) THEN le.tx END, '$.target') IS NOT NULL
              OR json_type(CASE WHEN json_valid(le.rx) THEN le.rx END, '$.repliedTo') = 'array'
          ))
          OR CASE WHEN json_valid(le.tx) THEN json_type(le.tx, '$.runtime') END = 'text'
          OR (le.op = 'kill' AND COALESCE(le.scheme, 'file') != 'log'
              AND json_extract(CASE WHEN json_valid(le.tx) THEN le.tx END, '$.target') IS NOT NULL)
      )
      AND le.state != 'proposed'
) candidate
WHERE recipient_session_id IS NOT NULL OR workspace_broadcast = 1;
