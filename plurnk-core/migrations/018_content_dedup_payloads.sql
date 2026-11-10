-- MIGRATE: 18 content dedup payloads
-- {§db-migrations} {§content-store} Intern turn_sources and log_entries payloads into contents (#1445).
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 5.0.0 support floor (schema version 11); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

-- Drop any process triggers attached to old turn_sources or log_entries tables before rebuild.
DROP TRIGGER IF EXISTS log_entries_advance_subscription_publication;
DROP TRIGGER IF EXISTS message_complete_on_reply;
DROP TRIGGER IF EXISTS log_entries_deliver_replies;
DROP TRIGGER IF EXISTS log_entries_append_ambient_event_insert;
DROP TRIGGER IF EXISTS log_entries_append_ambient_event_resolve;
DROP TRIGGER IF EXISTS log_entries_initialize_projection;
DROP TRIGGER IF EXISTS log_entries_apply_curation;
DROP TRIGGER IF EXISTS log_entries_retire_message_completions;

-- Drop baseline triggers that will be replaced on the new base tables and rebuilt child tables.
DROP TRIGGER IF EXISTS turn_sources_immutable;
DROP TRIGGER IF EXISTS turn_sources_delete_with_turn_only;
DROP TRIGGER IF EXISTS log_entries_emission_shape;
DROP TRIGGER IF EXISTS log_entries_emission_frozen;
DROP TRIGGER IF EXISTS log_entries_delete_with_owner_only;
DROP TRIGGER IF EXISTS log_entries_turn_ownership;
DROP TRIGGER IF EXISTS log_entries_model_call_valid;
DROP TRIGGER IF EXISTS log_entries_curation_payload_valid;
DROP TRIGGER IF EXISTS log_entries_immutable_core;
DROP TRIGGER IF EXISTS log_entries_immutable_attrs;
DROP TRIGGER IF EXISTS log_entries_ambient_event_once;
DROP TRIGGER IF EXISTS log_entry_projections_folded_valid_insert;
DROP TRIGGER IF EXISTS log_entry_projections_folded_valid_update;
DROP TRIGGER IF EXISTS log_entry_projections_kill_terminal;
DROP TRIGGER IF EXISTS log_entry_projections_delete_with_event_only;
DROP TRIGGER IF EXISTS log_entry_projections_emission_whole;
DROP TRIGGER IF EXISTS log_curation_effects_immutable;
DROP TRIGGER IF EXISTS log_curation_effects_delete_with_history_only;
DROP TRIGGER IF EXISTS log_curation_effects_valid;
DROP TRIGGER IF EXISTS proposal_decision_insert;
DROP TRIGGER IF EXISTS proposal_decision_immutable;
DROP TRIGGER IF EXISTS proposal_decision_history_lifetime;

COMMIT;
PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;
BEGIN IMMEDIATE;

-- Intern existing payloads into the content-addressed store.
INSERT INTO contents (hash, content)
SELECT sha256(content), content FROM turn_sources WHERE true
ON CONFLICT (hash) DO NOTHING;

INSERT INTO contents (hash, content)
SELECT sha256(tx), tx FROM log_entries WHERE true
ON CONFLICT (hash) DO NOTHING;

INSERT INTO contents (hash, content)
SELECT sha256(rx), rx FROM log_entries WHERE true
ON CONFLICT (hash) DO NOTHING;

INSERT INTO contents (hash, content)
SELECT CASE WHEN patch IS NOT NULL THEN sha256(patch) END, patch
FROM log_entries WHERE patch IS NOT NULL
ON CONFLICT (hash) DO NOTHING;

-- 1. turn_source_rows + turn_sources view
CREATE TABLE turn_source_rows (
    turn_id       INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL CHECK (kind IN ('ops', 'reasoning', 'note', 'outside')),
    sequence      INTEGER NOT NULL DEFAULT 0 CHECK ((kind = 'note' AND sequence > 0) OR (kind != 'note' AND sequence = 0)),
    content_id    INTEGER NOT NULL REFERENCES contents(id),
    model_call_id INTEGER REFERENCES model_calls(id),
    deep_hash     TEXT    REFERENCES derivations(deep_hash),
    PRIMARY KEY (turn_id, kind, sequence)
) STRICT, WITHOUT ROWID;

INSERT INTO turn_source_rows (turn_id, kind, sequence, content_id, model_call_id, deep_hash)
SELECT s.turn_id, s.kind, s.sequence, c.id, s.model_call_id, s.deep_hash
FROM turn_sources s
JOIN contents c ON c.hash = sha256(s.content);

DROP TABLE turn_sources;

CREATE INDEX turn_source_rows_content ON turn_source_rows (content_id);
CREATE INDEX turn_source_rows_model_call_id ON turn_source_rows (model_call_id) WHERE model_call_id IS NOT NULL;
CREATE INDEX turn_source_rows_deep_hash ON turn_source_rows (deep_hash) WHERE deep_hash IS NOT NULL;
CREATE INDEX turn_source_rows_pending_derivation ON turn_source_rows (turn_id) WHERE deep_hash IS NULL;

CREATE TRIGGER turn_source_rows_immutable
BEFORE UPDATE OF turn_id, kind, sequence, content_id, model_call_id ON turn_source_rows
BEGIN
    SELECT RAISE(ABORT, 'turn source evidence is immutable');
END;

CREATE TRIGGER turn_source_rows_delete_with_turn_only
BEFORE DELETE ON turn_source_rows
WHEN EXISTS (SELECT 1 FROM turns WHERE id = OLD.turn_id)
BEGIN
    SELECT RAISE(ABORT, 'turn source evidence belongs to its retained turn');
END;

CREATE VIEW turn_sources AS
SELECT r.turn_id, r.kind, r.sequence,
       c.content AS content,
       r.model_call_id, r.deep_hash
FROM turn_source_rows r
LEFT JOIN contents c ON c.id = r.content_id;

CREATE TRIGGER turn_sources_insert
INSTEAD OF INSERT ON turn_sources
BEGIN
    SELECT RAISE(ABORT, 'NOT NULL constraint failed: turn_source_rows.content') WHERE NEW.content IS NULL;
    INSERT INTO contents (hash, content) VALUES (sha256(NEW.content), NEW.content)
    ON CONFLICT (hash) DO NOTHING;
    INSERT INTO turn_source_rows (turn_id, kind, sequence, content_id, model_call_id, deep_hash)
    VALUES (
        NEW.turn_id,
        NEW.kind,
        COALESCE(NEW.sequence, 0),
        (SELECT id FROM contents WHERE hash = sha256(NEW.content)),
        NEW.model_call_id,
        NEW.deep_hash
    );
END;

CREATE TRIGGER turn_sources_update
INSTEAD OF UPDATE ON turn_sources
BEGIN
    SELECT RAISE(ABORT, 'turn source evidence is immutable')
    WHERE NEW.turn_id IS NOT OLD.turn_id
       OR NEW.kind IS NOT OLD.kind
       OR NEW.sequence IS NOT OLD.sequence
       OR NEW.content IS NOT OLD.content
       OR NEW.model_call_id IS NOT OLD.model_call_id;
    UPDATE turn_source_rows
    SET deep_hash = NEW.deep_hash
    WHERE turn_id = OLD.turn_id AND kind = OLD.kind AND sequence = OLD.sequence
      AND NEW.deep_hash IS NOT OLD.deep_hash;
END;

CREATE TRIGGER turn_sources_delete
INSTEAD OF DELETE ON turn_sources
BEGIN
    DELETE FROM turn_source_rows
    WHERE turn_id = OLD.turn_id AND kind = OLD.kind AND sequence = OLD.sequence;
END;

-- 2. log_entry_rows + child FK tables + log_entries view
CREATE TABLE log_entry_rows (
    id              INTEGER NOT NULL PRIMARY KEY,
    session_id      INTEGER NOT NULL,
    loop_id         INTEGER NOT NULL,
    turn_id         INTEGER NOT NULL,
    sequence        INTEGER NOT NULL           CHECK (sequence >= 1),
    at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    origin          TEXT    NOT NULL           CHECK (origin IN ('model', 'client', '_plurnk', 'plugin')),
    source          TEXT,
    ambient_event_id INTEGER                  REFERENCES ambient_events(id),
    inherited_history INTEGER NOT NULL DEFAULT 0 CHECK (inherited_history IN (0, 1)),
    deep_hash       TEXT                       REFERENCES derivations(deep_hash),
    model_call_id   INTEGER                    REFERENCES model_calls(id),
    subscription_publication_id INTEGER        REFERENCES subscription_publications(id) ON DELETE SET NULL,
    op              TEXT,
    signal          TEXT                       CHECK (signal IS NULL OR json_valid(signal)),
    scheme          TEXT                       CHECK (scheme IS NULL OR length(scheme) > 0),
    username        TEXT,
    password        TEXT,
    hostname        TEXT,
    port            INTEGER                    CHECK (port IS NULL OR (port BETWEEN 0 AND 65535)),
    pathname        TEXT,
    query           TEXT,
    fragment        TEXT,
    lineMarker      TEXT                       CHECK (lineMarker IS NULL OR json_valid(lineMarker)),
    tx_content_id   INTEGER NOT NULL           REFERENCES contents(id),
    mimetype_tx     TEXT    NOT NULL           CHECK (length(mimetype_tx) > 0),
    rx_content_id   INTEGER NOT NULL           REFERENCES contents(id),
    mimetype_rx     TEXT    NOT NULL           CHECK (length(mimetype_rx) > 0),
    status_rx       INTEGER NOT NULL           CHECK (status_rx BETWEEN 100 AND 599),
    native_content_hash TEXT                   REFERENCES native_contents(hash),
    weight          INTEGER NOT NULL DEFAULT 0 CHECK (weight >= 0),
    state           TEXT    NOT NULL DEFAULT 'resolved'
                    CHECK (state IN ('proposed', 'resolved', 'failed', 'cancelled')),
    outcome         TEXT,
    attrs           TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
    initial_folded  TEXT    NOT NULL DEFAULT '[]'
                    CHECK (json_valid(initial_folded) AND json_type(initial_folded) = 'array'),
    patch_content_id INTEGER                   REFERENCES contents(id),
    CHECK (
        (op IS NULL) = COALESCE(
            json_extract(attrs, '$.kind') = 'emissionAttempt',
            0
        )
    ),
    CHECK (json_extract(attrs, '$.kind') != 'emissionAttempt' OR origin = 'model'),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (loop_id)    REFERENCES loops(id)    ON DELETE CASCADE,
    FOREIGN KEY (turn_id)    REFERENCES turns(id)    ON DELETE CASCADE
) STRICT;

INSERT INTO log_entry_rows (
    id, session_id, loop_id, turn_id, sequence, at, origin, source,
    ambient_event_id, inherited_history, deep_hash, model_call_id, subscription_publication_id,
    op, signal, scheme, username, password, hostname, port, pathname, query, fragment, lineMarker,
    tx_content_id, mimetype_tx, rx_content_id, mimetype_rx, status_rx, native_content_hash,
    weight, state, outcome, attrs, initial_folded, patch_content_id
)
SELECT
    le.id, le.session_id, le.loop_id, le.turn_id, le.sequence, le.at, le.origin, le.source,
    le.ambient_event_id, le.inherited_history, le.deep_hash, le.model_call_id, le.subscription_publication_id,
    le.op, le.signal, le.scheme, le.username, le.password, le.hostname, le.port, le.pathname, le.query, le.fragment, le.lineMarker,
    tx_c.id, le.mimetype_tx, rx_c.id, le.mimetype_rx, le.status_rx,
    CASE WHEN le.mimetype_rx = 'application/json' AND json_valid(le.rx)
         THEN json_extract(le.rx, '$.nativeContentHash') END,
    le.weight, le.state, le.outcome, le.attrs, le.initial_folded,
    CASE WHEN le.patch IS NOT NULL
         THEN (SELECT id FROM contents WHERE hash = sha256(le.patch)) END
FROM log_entries le
JOIN contents tx_c ON tx_c.hash = sha256(le.tx)
JOIN contents rx_c ON rx_c.hash = sha256(le.rx);

DROP TABLE log_entries;

CREATE UNIQUE INDEX log_entry_rows_turn_id_sequence ON log_entry_rows (turn_id, sequence);
CREATE INDEX log_entry_rows_session_id ON log_entry_rows (session_id);
CREATE INDEX log_entry_rows_loop_id ON log_entry_rows (loop_id);
CREATE INDEX log_entry_rows_deep_hash ON log_entry_rows (deep_hash) WHERE deep_hash IS NOT NULL;
CREATE INDEX log_entry_rows_pending_derivation ON log_entry_rows (session_id, id) WHERE deep_hash IS NULL;
CREATE UNIQUE INDEX log_entry_rows_model_call_id ON log_entry_rows (model_call_id) WHERE model_call_id IS NOT NULL;
CREATE INDEX log_entry_rows_subscription_publication_id ON log_entry_rows (subscription_publication_id) WHERE subscription_publication_id IS NOT NULL;
CREATE UNIQUE INDEX log_entry_rows_session_ambient_event ON log_entry_rows (session_id, ambient_event_id) WHERE ambient_event_id IS NOT NULL;
CREATE INDEX log_entry_rows_ambient_event_id ON log_entry_rows (ambient_event_id) WHERE ambient_event_id IS NOT NULL;
CREATE UNIQUE INDEX log_entry_rows_emission_turn ON log_entry_rows (turn_id) WHERE json_extract(attrs, '$.kind') = 'emission';
CREATE INDEX log_entry_rows_tx_content ON log_entry_rows (tx_content_id);
CREATE INDEX log_entry_rows_rx_content ON log_entry_rows (rx_content_id);
CREATE INDEX log_entry_rows_patch_content ON log_entry_rows (patch_content_id) WHERE patch_content_id IS NOT NULL;
CREATE INDEX log_entry_rows_native_content_hash ON log_entry_rows (native_content_hash) WHERE native_content_hash IS NOT NULL;

-- Rebuild child FK tables referencing log_entry_rows(id).
CREATE TABLE message_completions_new (
    message_id  INTEGER PRIMARY KEY REFERENCES loop_messages(id) ON DELETE CASCADE,
    response_id INTEGER NOT NULL REFERENCES log_entry_rows(id),
    status      INTEGER NOT NULL CHECK (status IN (200, 499))
) STRICT;

INSERT INTO message_completions_new (message_id, response_id, status)
SELECT message_id, response_id, status FROM message_completions;

DROP TABLE message_completions;
ALTER TABLE message_completions_new RENAME TO message_completions;

CREATE INDEX message_completions_response_id ON message_completions (response_id);

CREATE TABLE log_entry_projections_new (
    log_entry_id INTEGER NOT NULL PRIMARY KEY,
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    folded       TEXT    NOT NULL DEFAULT '[]'
                         CHECK (json_valid(folded) AND json_type(folded) = 'array'),
    FOREIGN KEY (log_entry_id) REFERENCES log_entry_rows(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO log_entry_projections_new (log_entry_id, active, folded)
SELECT log_entry_id, active, folded FROM log_entry_projections;

DROP TABLE log_entry_projections;
ALTER TABLE log_entry_projections_new RENAME TO log_entry_projections;

CREATE TABLE log_curation_effects_new (
    operation_log_entry_id INTEGER NOT NULL,
    target_log_entry_id    INTEGER NOT NULL,
    active_before          INTEGER NOT NULL CHECK (active_before IN (0, 1)),
    active_after           INTEGER NOT NULL CHECK (active_after IN (0, 1)),
    folded_before          TEXT    NOT NULL
                                  CHECK (json_valid(folded_before) AND json_type(folded_before) = 'array'),
    folded_after           TEXT    NOT NULL
                                  CHECK (json_valid(folded_after) AND json_type(folded_after) = 'array'),
    PRIMARY KEY (operation_log_entry_id, target_log_entry_id),
    CHECK (operation_log_entry_id != target_log_entry_id),
    FOREIGN KEY (operation_log_entry_id) REFERENCES log_entry_rows(id) ON DELETE CASCADE,
    FOREIGN KEY (target_log_entry_id)    REFERENCES log_entry_rows(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO log_curation_effects_new (
    operation_log_entry_id, target_log_entry_id,
    active_before, active_after, folded_before, folded_after
)
SELECT operation_log_entry_id, target_log_entry_id,
       active_before, active_after, folded_before, folded_after
FROM log_curation_effects;

DROP TABLE log_curation_effects;
ALTER TABLE log_curation_effects_new RENAME TO log_curation_effects;

CREATE INDEX log_curation_effects_target ON log_curation_effects (target_log_entry_id);

CREATE TABLE proposal_decisions_new (
    log_entry_id INTEGER PRIMARY KEY REFERENCES log_entry_rows(id) ON DELETE CASCADE,
    decision     TEXT NOT NULL CHECK (decision IN ('accept', 'reject', 'cancel')),
    resolver     TEXT NOT NULL CHECK (length(resolver) > 0),
    body         TEXT,
    outcome      TEXT,
    decided_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO proposal_decisions_new (log_entry_id, decision, resolver, body, outcome, decided_at)
SELECT log_entry_id, decision, resolver, body, outcome, decided_at
FROM proposal_decisions;

DROP TABLE proposal_decisions;
ALTER TABLE proposal_decisions_new RENAME TO proposal_decisions;

-- View log_entries + INSTEAD OF triggers
CREATE VIEW log_entries AS
SELECT r.id, r.session_id, r.loop_id, r.turn_id, r.sequence,
       r.at, r.origin, r.source, r.ambient_event_id, r.inherited_history,
       r.deep_hash, r.model_call_id, r.subscription_publication_id,
       r.op, r.signal, r.scheme, r.username, r.password,
       r.hostname, r.port, r.pathname, r.query, r.fragment, r.lineMarker,
       tx_c.content AS tx, r.mimetype_tx,
       rx_c.content AS rx, r.mimetype_rx, r.status_rx, r.native_content_hash,
       r.weight, r.state, r.outcome, r.attrs, r.initial_folded,
       patch_c.content AS patch
FROM log_entry_rows r
LEFT JOIN contents tx_c ON tx_c.id = r.tx_content_id
LEFT JOIN contents rx_c ON rx_c.id = r.rx_content_id
LEFT JOIN contents patch_c ON patch_c.id = r.patch_content_id;

CREATE TRIGGER log_entries_insert
INSTEAD OF INSERT ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'NOT NULL constraint failed: log_entry_rows.tx') WHERE NEW.tx IS NULL;
    SELECT RAISE(ABORT, 'NOT NULL constraint failed: log_entry_rows.rx') WHERE NEW.rx IS NULL;
    INSERT INTO contents (hash, content) VALUES (sha256(NEW.tx), NEW.tx)
    ON CONFLICT (hash) DO NOTHING;
    INSERT INTO contents (hash, content) VALUES (sha256(NEW.rx), NEW.rx)
    ON CONFLICT (hash) DO NOTHING;
    INSERT INTO contents (hash, content)
    SELECT sha256(NEW.patch), NEW.patch WHERE NEW.patch IS NOT NULL
    ON CONFLICT (hash) DO NOTHING;
    INSERT INTO log_entry_rows (
        id, session_id, loop_id, turn_id, sequence, at, origin, source,
        ambient_event_id, inherited_history, deep_hash, model_call_id, subscription_publication_id,
        op, signal, scheme, username, password, hostname, port, pathname, query, fragment, lineMarker,
        tx_content_id, mimetype_tx, rx_content_id, mimetype_rx, status_rx, native_content_hash,
        weight, state, outcome, attrs, initial_folded, patch_content_id
    ) VALUES (
        NEW.id,
        NEW.session_id,
        NEW.loop_id,
        NEW.turn_id,
        NEW.sequence,
        COALESCE(NEW.at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        NEW.origin,
        NEW.source,
        NEW.ambient_event_id,
        COALESCE(NEW.inherited_history, 0),
        NEW.deep_hash,
        NEW.model_call_id,
        NEW.subscription_publication_id,
        NEW.op,
        NEW.signal,
        NEW.scheme,
        NEW.username,
        NEW.password,
        NEW.hostname,
        NEW.port,
        NEW.pathname,
        NEW.query,
        NEW.fragment,
        NEW.lineMarker,
        (SELECT id FROM contents WHERE hash = sha256(NEW.tx)),
        NEW.mimetype_tx,
        (SELECT id FROM contents WHERE hash = sha256(NEW.rx)),
        NEW.mimetype_rx,
        NEW.status_rx,
        CASE WHEN NEW.mimetype_rx = 'application/json' AND json_valid(NEW.rx)
             THEN json_extract(NEW.rx, '$.nativeContentHash') END,
        COALESCE(NEW.weight, 0),
        COALESCE(NEW.state, 'resolved'),
        NEW.outcome,
        COALESCE(NEW.attrs, '{}'),
        COALESCE(NEW.initial_folded, '[]'),
        CASE WHEN NEW.patch IS NOT NULL
             THEN (SELECT id FROM contents WHERE hash = sha256(NEW.patch)) END
    );
END;

CREATE TRIGGER log_entries_update
INSTEAD OF UPDATE ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only lifecycle outcome and derived attachments may change')
    WHERE NEW.id IS NOT OLD.id
       OR NEW.session_id IS NOT OLD.session_id
       OR NEW.loop_id IS NOT OLD.loop_id
       OR NEW.turn_id IS NOT OLD.turn_id
       OR NEW.sequence IS NOT OLD.sequence
       OR NEW.at IS NOT OLD.at
       OR NEW.origin IS NOT OLD.origin
       OR NEW.source IS NOT OLD.source
       OR NEW.inherited_history IS NOT OLD.inherited_history
       OR NEW.model_call_id IS NOT OLD.model_call_id
       OR NEW.op IS NOT OLD.op
       OR NEW.signal IS NOT OLD.signal
       OR NEW.scheme IS NOT OLD.scheme
       OR NEW.username IS NOT OLD.username
       OR NEW.password IS NOT OLD.password
       OR NEW.hostname IS NOT OLD.hostname
       OR NEW.port IS NOT OLD.port
       OR NEW.pathname IS NOT OLD.pathname
       OR NEW.query IS NOT OLD.query
       OR NEW.fragment IS NOT OLD.fragment
       OR NEW.lineMarker IS NOT OLD.lineMarker
       OR NEW.tx IS NOT OLD.tx
       OR NEW.mimetype_tx IS NOT OLD.mimetype_tx
       OR NEW.mimetype_rx IS NOT OLD.mimetype_rx
       OR NEW.initial_folded IS NOT OLD.initial_folded;
    SELECT RAISE(ABORT, 'an emission row is frozen')
    WHERE json_extract(OLD.attrs, '$.kind') = 'emission'
      AND (NEW.rx IS NOT OLD.rx OR NEW.status_rx IS NOT OLD.status_rx
           OR NEW.state IS NOT OLD.state OR NEW.outcome IS NOT OLD.outcome
           OR NEW.weight IS NOT OLD.weight);
    SELECT RAISE(ABORT, 'NOT NULL constraint failed: log_entry_rows.rx') WHERE NEW.rx IS NULL;
    INSERT INTO contents (hash, content)
    SELECT sha256(NEW.rx), NEW.rx WHERE NEW.rx IS NOT OLD.rx
    ON CONFLICT (hash) DO NOTHING;
    INSERT INTO contents (hash, content)
    SELECT sha256(NEW.patch), NEW.patch WHERE NEW.patch IS NOT OLD.patch AND NEW.patch IS NOT NULL
    ON CONFLICT (hash) DO NOTHING;
    UPDATE log_entry_rows
    SET rx_content_id = (SELECT id FROM contents WHERE hash = sha256(NEW.rx)),
        native_content_hash = CASE WHEN NEW.mimetype_rx = 'application/json' AND json_valid(NEW.rx)
                                   THEN json_extract(NEW.rx, '$.nativeContentHash') END,
        status_rx = NEW.status_rx,
        state = NEW.state,
        outcome = NEW.outcome,
        weight = NEW.weight
    WHERE id = OLD.id
      AND (NEW.rx IS NOT OLD.rx OR NEW.status_rx IS NOT OLD.status_rx
           OR NEW.state IS NOT OLD.state OR NEW.outcome IS NOT OLD.outcome
           OR NEW.weight IS NOT OLD.weight);
    UPDATE log_entry_rows
    SET patch_content_id = CASE WHEN NEW.patch IS NOT NULL
                                THEN (SELECT id FROM contents WHERE hash = sha256(NEW.patch)) END
    WHERE id = OLD.id AND NEW.patch IS NOT OLD.patch;
    UPDATE log_entry_rows
    SET attrs = NEW.attrs
    WHERE id = OLD.id AND NEW.attrs IS NOT OLD.attrs;
    UPDATE log_entry_rows
    SET ambient_event_id = NEW.ambient_event_id
    WHERE id = OLD.id AND NEW.ambient_event_id IS NOT OLD.ambient_event_id;
    UPDATE log_entry_rows
    SET subscription_publication_id = NEW.subscription_publication_id
    WHERE id = OLD.id AND NEW.subscription_publication_id IS NOT OLD.subscription_publication_id;
    UPDATE log_entry_rows
    SET deep_hash = NEW.deep_hash
    WHERE id = OLD.id AND NEW.deep_hash IS NOT OLD.deep_hash;
END;

CREATE TRIGGER log_entries_delete
INSTEAD OF DELETE ON log_entries
BEGIN
    DELETE FROM log_entry_rows WHERE id = OLD.id;
END;

-- Baseline guard triggers on log_entry_rows and rebuilt child tables.
CREATE TRIGGER log_entry_rows_emission_shape
BEFORE INSERT ON log_entry_rows
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
      AND json_type((SELECT content FROM contents WHERE id = NEW.rx_content_id), '$.content') = 'text'
      AND length(json_extract((SELECT content FROM contents WHERE id = NEW.rx_content_id), '$.content')) > 0
      AND NEW.pathname = (
          SELECT '/' || l.sequence || '/' || t.sequence
          FROM turns t JOIN loops l ON l.id = t.loop_id
          WHERE t.id = NEW.turn_id
      )
      AND (SELECT kind FROM turns WHERE id = NEW.turn_id) IN ('inference', 'initialization')
      AND EXISTS (
          SELECT 1 FROM turn_source_rows
          WHERE turn_id = NEW.turn_id AND kind = 'ops' AND sequence = 0
      )
      AND NOT EXISTS (
          SELECT 1 FROM log_entry_rows
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

CREATE TRIGGER log_entry_rows_emission_frozen
BEFORE UPDATE OF rx_content_id, status_rx, state, outcome, weight ON log_entry_rows
WHEN json_extract(OLD.attrs, '$.kind') = 'emission'
BEGIN
    SELECT RAISE(ABORT, 'an emission row is frozen');
END;

CREATE TRIGGER log_entry_rows_delete_with_owner_only
BEFORE DELETE ON log_entry_rows
WHEN EXISTS (
    SELECT 1
    FROM turns
    JOIN loops ON loops.id = turns.loop_id
    JOIN sessions ON sessions.id = loops.session_id
    JOIN workspaces ON workspaces.id = sessions.workspace_id
    WHERE turns.id = OLD.turn_id
)
BEGIN
    SELECT RAISE(ABORT, 'log entries can only be removed with their containing history');
END;

CREATE TRIGGER log_entry_rows_turn_ownership
BEFORE INSERT ON log_entry_rows
WHEN NEW.session_id IS NOT NULL
 AND NEW.loop_id IS NOT NULL
 AND NEW.turn_id IS NOT NULL
 AND NEW.origin IN ('model', 'client', '_plurnk', 'plugin')
 AND EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id)
 AND EXISTS (SELECT 1 FROM loops WHERE id = NEW.loop_id)
 AND EXISTS (SELECT 1 FROM turns WHERE id = NEW.turn_id)
 AND NOT EXISTS (
    SELECT 1
    FROM turns
    JOIN loops ON loops.id = turns.loop_id
    WHERE turns.id = NEW.turn_id
      AND loops.id = NEW.loop_id
      AND loops.session_id = NEW.session_id
      AND (NEW.origin = turns.producer OR NEW.origin = '_plurnk')
)
BEGIN
    SELECT RAISE(ABORT, 'log entry must match its turn ownership and producer');
END;

CREATE TRIGGER log_entry_rows_model_call_valid
BEFORE INSERT ON log_entry_rows
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

CREATE TRIGGER log_entry_rows_curation_payload_valid
BEFORE INSERT ON log_entry_rows
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

CREATE TRIGGER log_entry_rows_immutable_core
BEFORE UPDATE OF
    session_id, loop_id, turn_id, sequence, at, origin, source, inherited_history, model_call_id,
    op, signal, scheme, username, password, hostname,
    port, pathname, query, fragment, lineMarker, tx_content_id, mimetype_tx, mimetype_rx, initial_folded
ON log_entry_rows
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only lifecycle outcome and derived attachments may change');
END;

CREATE TRIGGER log_entry_rows_immutable_attrs
BEFORE UPDATE OF attrs ON log_entry_rows
WHEN COALESCE((
    json_type(OLD.attrs, '$.__plurnk_curation') = 'object'
    AND NEW.attrs = json_remove(OLD.attrs, '$.__plurnk_curation')
), 0) = 0
BEGIN
    SELECT RAISE(ABORT, 'log_entries attrs are immutable outside curation payload removal');
END;

CREATE TRIGGER log_entry_rows_ambient_event_once
BEFORE UPDATE OF ambient_event_id ON log_entry_rows
WHEN NOT (
    (OLD.ambient_event_id IS NULL AND NEW.ambient_event_id IS NOT NULL)
    OR (NEW.ambient_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM ambient_events WHERE id = OLD.ambient_event_id))
)
BEGIN
    SELECT RAISE(ABORT, 'log_entries ambient event identity may only be assigned once');
END;

CREATE TRIGGER log_entry_projections_folded_valid_insert
BEFORE INSERT ON log_entry_projections
WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.folded) range
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
           FROM json_each(NEW.folded) previous
           WHERE previous.key = range.key - 1
             AND (
                 json_extract(previous.value, '$[1]') = -1
                 OR json_extract(range.value, '$[0]') <= json_extract(previous.value, '$[1]') + 1
             )
       )
)
BEGIN
    SELECT RAISE(ABORT, 'log entry projection folded ranges are invalid');
END;

CREATE TRIGGER log_entry_projections_folded_valid_update
BEFORE UPDATE OF folded ON log_entry_projections
WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.folded) range
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
           FROM json_each(NEW.folded) previous
           WHERE previous.key = range.key - 1
             AND (
                 json_extract(previous.value, '$[1]') = -1
                 OR json_extract(range.value, '$[0]') <= json_extract(previous.value, '$[1]') + 1
             )
       )
)
BEGIN
    SELECT RAISE(ABORT, 'log entry projection folded ranges are invalid');
END;

CREATE TRIGGER log_entry_projections_kill_terminal
BEFORE UPDATE OF active ON log_entry_projections
WHEN OLD.active = 0 AND NEW.active != 0
BEGIN
    SELECT RAISE(ABORT, 'a killed log entry cannot re-enter the active projection');
END;

CREATE TRIGGER log_entry_projections_delete_with_event_only
BEFORE DELETE ON log_entry_projections
WHEN EXISTS (SELECT 1 FROM log_entry_rows WHERE id = OLD.log_entry_id)
BEGIN
    SELECT RAISE(ABORT, 'a durable log event must retain its projection');
END;

CREATE TRIGGER log_entry_projections_emission_whole
BEFORE UPDATE OF folded ON log_entry_projections
WHEN json(NEW.folded) != json('[]')
  AND EXISTS (
      SELECT 1 FROM log_entry_rows
      WHERE id = NEW.log_entry_id AND json_extract(attrs, '$.kind') = 'emission'
  )
BEGIN
    SELECT RAISE(ABORT, 'an emission row is curated whole');
END;

CREATE TRIGGER log_curation_effects_immutable
BEFORE UPDATE ON log_curation_effects
BEGIN
    SELECT RAISE(ABORT, 'log curation effects are immutable execution evidence');
END;

CREATE TRIGGER log_curation_effects_delete_with_history_only
BEFORE DELETE ON log_curation_effects
WHEN EXISTS (
    SELECT 1 FROM log_entry_rows WHERE id = OLD.operation_log_entry_id
)
AND EXISTS (
    SELECT 1 FROM log_entry_rows WHERE id = OLD.target_log_entry_id
)
BEGIN
    SELECT RAISE(ABORT, 'log curation effects can only be removed with their containing history');
END;

CREATE TRIGGER log_curation_effects_valid
BEFORE INSERT ON log_curation_effects
BEGIN
    SELECT CASE WHEN
        NOT EXISTS (
            SELECT 1
            FROM log_entry_rows operation
            JOIN log_entry_rows target ON target.id = NEW.target_log_entry_id
            WHERE operation.id = NEW.operation_log_entry_id
              AND operation.op = 'kill'
              AND operation.status_rx < 400
              AND operation.session_id = target.session_id
        )
        OR NOT EXISTS (
            SELECT 1
            FROM log_entry_rows operation
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

CREATE TRIGGER proposal_decision_insert
BEFORE INSERT ON proposal_decisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM log_entry_rows le JOIN sessions w ON w.id = le.session_id
        WHERE le.id = NEW.log_entry_id AND le.state = 'proposed'
          AND (NEW.resolver = '_plurnk' OR NEW.resolver = w.owner)
    ) THEN RAISE(ABORT, 'proposal decision requires a pending operation and its resolving authority') END;
END;

CREATE TRIGGER proposal_decision_immutable
BEFORE UPDATE ON proposal_decisions
BEGIN
    SELECT RAISE(ABORT, 'proposal decisions are immutable');
END;

CREATE TRIGGER proposal_decision_history_lifetime
BEFORE DELETE ON proposal_decisions
WHEN EXISTS (SELECT 1 FROM log_entry_rows WHERE id = OLD.log_entry_id)
BEGIN
    SELECT RAISE(ABORT, 'proposal decisions belong to operation history');
END;

PRAGMA foreign_key_check;
COMMIT;
PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
