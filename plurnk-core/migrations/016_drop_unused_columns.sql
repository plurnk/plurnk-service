-- MIGRATE: 16 drop unused columns
-- Released in 6.0.0 and frozen ({§db-migrations}).
-- {§db-migrations} Drop unreferenced and write-only columns across tables and views (#1435).
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 5.0.0 support floor (schema version 11); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

DROP VIEW IF EXISTS active_log_entries;
DROP VIEW IF EXISTS turn_packets;
DROP TRIGGER IF EXISTS entry_channel_rows_settle_publications;
DROP TRIGGER IF EXISTS log_entries_advance_subscription_publication;

ALTER TABLE workspaces DROP COLUMN version;
ALTER TABLE loops DROP COLUMN version;
ALTER TABLE turns DROP COLUMN version;
ALTER TABLE entries DROP COLUMN version;
ALTER TABLE log_entries DROP COLUMN version;
ALTER TABLE subscriptions DROP COLUMN version;
ALTER TABLE subscriptions DROP COLUMN turn_scoped;
ALTER TABLE subscription_publications DROP COLUMN version;
ALTER TABLE client_interactions DROP COLUMN created_at;
ALTER TABLE model_routes DROP COLUMN created_at;
ALTER TABLE workspace_module_state DROP COLUMN updated_at;
ALTER TABLE session_module_state DROP COLUMN updated_at;

CREATE VIEW active_log_entries AS
SELECT le.id, le.session_id, le.loop_id, le.turn_id, le.sequence,
       le.origin, le.source,
       le.deep_hash,
       le.op, le.signal, le.scheme, le.username, le.password,
       le.hostname, le.port, le.pathname, le.query, le.fragment,
       le.tx, le.mimetype_tx,
       le.rx, le.mimetype_rx, le.status_rx, le.weight,
       le.state, le.outcome, le.attrs, le.initial_folded, le.patch, projection.folded
FROM log_entries le
JOIN log_entry_projections projection ON projection.log_entry_id = le.id
WHERE projection.active = 1;

CREATE VIEW turn_packets AS
SELECT t.id, t.loop_id, t.sequence, t.timestamp, t.producer, t.kind, t.status, t.completed_at,
       t.usage_curation_budget, t.finish_reason, t.model, t.meta,
       CASE WHEN t.packet IS NULL THEN NULL ELSE json_set(t.packet, '$.sections', json((
           SELECT COALESCE(json_group_array(json_object(
               'name', ts.name, 'slot', ts.slot, 'header', ts.header, 'weight', ts.weight,
               'content', COALESCE((
                   SELECT group_concat(pi.text, char(10) || char(10) ORDER BY tsi.position)
                   FROM turn_section_items tsi JOIN packet_items pi ON pi.hash = tsi.item_hash
                   WHERE tsi.turn_id = ts.turn_id AND tsi.section = ts.position
               ), '')
           ) ORDER BY ts.position), '[]')
           FROM turn_sections ts WHERE ts.turn_id = t.id
       ))) END AS packet
FROM turns t;

DROP TRIGGER IF EXISTS sessions_provider_identity_immutable;
DROP TRIGGER IF EXISTS sessions_fork_event_boundary_immutable;
DROP TRIGGER IF EXISTS session_owner_insert;
DROP TRIGGER IF EXISTS session_owner_update;

COMMIT;
PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;
BEGIN IMMEDIATE;

CREATE TABLE sessions_new (
    id              INTEGER NOT NULL PRIMARY KEY,
    workspace_id    INTEGER NOT NULL,
    wake_revision   INTEGER NOT NULL DEFAULT 0 CHECK (wake_revision >= 0),
    name            TEXT    NOT NULL CHECK (length(name) > 0),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    provider_identity TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
        CHECK (length(provider_identity) = 32 AND provider_identity NOT GLOB '*[^0-9a-f]*'),
    model_route_id       INTEGER          REFERENCES model_routes(id),
    spawn_model_route_id INTEGER          REFERENCES model_routes(id),
    effort          TEXT CHECK (effort IS NULL OR length(effort) > 0),
    effort_source   TEXT NOT NULL DEFAULT 'default' CHECK (effort_source IN ('default', 'explicit')),
    parent_session_id INTEGER          CHECK (parent_session_id IS NULL OR parent_session_id != id),
    origin          TEXT    NOT NULL DEFAULT 'client' CHECK (origin IN ('model', 'client', '_plurnk')),
    cancelled_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_through_sequence >= 0),
    cancellation TEXT CHECK (cancellation IS NULL OR (json_valid(cancellation) AND json_extract(cancellation, '$.status') = 499)),
    ambient_event_cursor INTEGER      CHECK (ambient_event_cursor IS NULL OR ambient_event_cursor >= 0),
    fork_event_boundary INTEGER       CHECK (fork_event_boundary IS NULL OR fork_event_boundary >= 0),
    owner           TEXT    NOT NULL DEFAULT '_plurnk' CHECK (length(owner) > 0),
    archived_at     TEXT CHECK (archived_at IS NULL OR length(archived_at) > 0),
    archived_by     INTEGER REFERENCES sessions(id),
    title           TEXT CHECK (title IS NULL OR length(title) > 0),
    CHECK ((archived_at IS NULL) = (archived_by IS NULL)),
    CHECK (fork_event_boundary IS NULL OR parent_session_id IS NOT NULL),
    CHECK ((model_route_id IS NULL) = (effort IS NULL)),
    FOREIGN KEY (workspace_id)      REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)   ON DELETE CASCADE
) STRICT;

INSERT INTO sessions_new (
    id, workspace_id, wake_revision, name, created_at, provider_identity,
    model_route_id, spawn_model_route_id, effort, effort_source, parent_session_id,
    origin, cancelled_through_sequence, cancellation, ambient_event_cursor,
    fork_event_boundary, owner, archived_at, archived_by, title
)
SELECT
    id, workspace_id, wake_revision, name, created_at, provider_identity,
    model_route_id, spawn_model_route_id, effort, effort_source, parent_session_id,
    origin, cancelled_through_sequence, cancellation, ambient_event_cursor,
    fork_event_boundary, owner, archived_at, archived_by, title
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX sessions_workspace_id_created_at ON sessions (workspace_id, created_at);
CREATE INDEX sessions_parent_session_id       ON sessions (parent_session_id);
CREATE UNIQUE INDEX sessions_provider_identity ON sessions (provider_identity);
CREATE UNIQUE INDEX sessions_workspace_name   ON sessions (workspace_id, name);
CREATE INDEX sessions_model_route_id          ON sessions (model_route_id)       WHERE model_route_id IS NOT NULL;
CREATE INDEX sessions_spawn_model_route_id    ON sessions (spawn_model_route_id) WHERE spawn_model_route_id IS NOT NULL;
CREATE INDEX sessions_owner                   ON sessions (workspace_id, owner);
CREATE INDEX sessions_archived_by             ON sessions (archived_by)          WHERE archived_by IS NOT NULL;

CREATE TRIGGER sessions_provider_identity_immutable
BEFORE UPDATE OF provider_identity ON sessions
WHEN NEW.provider_identity != OLD.provider_identity
BEGIN
    SELECT RAISE(ABORT, 'sessions.provider_identity is immutable');
END;

CREATE TRIGGER sessions_fork_event_boundary_immutable
BEFORE UPDATE OF fork_event_boundary ON sessions
WHEN NEW.fork_event_boundary IS NOT OLD.fork_event_boundary
BEGIN
    SELECT RAISE(ABORT, 'sessions.fork_event_boundary is immutable');
END;

CREATE TRIGGER session_owner_insert
BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id) AND NOT EXISTS (
    SELECT 1 FROM session_owners WHERE workspace_id = NEW.workspace_id AND address = NEW.owner
)
OR (NEW.origin = '_plurnk' AND NEW.owner != '_plurnk')
OR (NEW.parent_session_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM sessions WHERE id = NEW.parent_session_id AND workspace_id != NEW.workspace_id
))
BEGIN
    SELECT RAISE(ABORT, 'session owner or parent does not belong to its workspace');
END;

CREATE TRIGGER session_owner_update
BEFORE UPDATE OF owner, workspace_id ON sessions
WHEN NOT EXISTS (
    SELECT 1 FROM session_owners WHERE workspace_id = NEW.workspace_id AND address = NEW.owner
)
OR (NEW.origin = '_plurnk' AND NEW.owner != '_plurnk')
BEGIN
    SELECT RAISE(ABORT, 'session owner does not belong to its workspace');
END;

PRAGMA foreign_key_check;
COMMIT;
PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
