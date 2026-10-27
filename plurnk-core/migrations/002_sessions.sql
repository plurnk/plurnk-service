-- MIGRATE: 2 sessions
-- Chapter 2 of the schema baseline ({§db-migrations}): Sessions over a workspace, their owners, external references, model routes, and the ambient event feed their siblings observe.
-- Released and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never
-- an edit here.

-- model_routes — the immutable resolved model route ({§session-model-selection}). One row per
-- complete resolved tuple; append-only. Alias is provenance plus a tuning scope,
-- not route identity, and is absent on a direct provider/model selection.
CREATE TABLE IF NOT EXISTS model_routes (
    id         INTEGER NOT NULL PRIMARY KEY,
    alias      TEXT             CHECK (alias IS NULL OR length(alias) > 0),
    provider   TEXT    NOT NULL CHECK (length(provider) > 0),
    model      TEXT    NOT NULL CHECK (length(model) > 0),
    base_url   TEXT             CHECK (base_url IS NULL OR length(base_url) > 0),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS model_routes_identity
ON model_routes (coalesce(alias, ''), provider, model, coalesce(base_url, ''));

-- {§session-ownership} {§session-ownership}: ownership is durable; an owner states whether
-- a person attends it. The runtime owner (`_plurnk`) holds no client tools and is never interactive.
CREATE TABLE IF NOT EXISTS session_owners (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    address      TEXT    NOT NULL CHECK (length(address) > 0),
    tools        TEXT    NOT NULL CHECK (json_valid(tools) AND json_type(tools) = 'array'),
    interactive  INTEGER NOT NULL DEFAULT 0
                         CHECK (interactive IN (0, 1) AND (address != '_plurnk' OR interactive = 0)),
    PRIMARY KEY (workspace_id, address),
    CHECK (address != '_plurnk' OR tools = '[]')
) STRICT;

-- sessions
CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER NOT NULL PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    workspace_id    INTEGER NOT NULL,
    -- {§session-wait-timing}: completion events, not packet/log curation state.
    wake_revision   INTEGER NOT NULL DEFAULT 0 CHECK (wake_revision >= 0),
    name            TEXT    NOT NULL CHECK (length(name) > 0),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- {§machine-processes}: provider affinity must not collide when
    -- independent databases reuse local integer ids.
    provider_identity TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
        CHECK (length(provider_identity) = 32 AND provider_identity NOT GLOB '*[^0-9a-f]*'),
    -- {§session-model-selection}: the session's durable resolved model, NULL for non-model
    -- sessions or a deliberately modelless unresolved session. spawn_model_route_id is the
    -- persistent spawn override; NULL means "use my model."
    model_route_id       INTEGER          REFERENCES model_routes(id),
    spawn_model_route_id INTEGER          REFERENCES model_routes(id),
    -- {§session-model-selection}: durable generation effort policy.
    effort          TEXT CHECK (effort IS NULL OR length(effort) > 0),
    -- {§session-model-selection}: whether effort was explicitly selected or defaulted.
    effort_source   TEXT NOT NULL DEFAULT 'default' CHECK (effort_source IN ('default', 'explicit')),
    -- sessions fork via parent_session_id; workspaces carry no parent — {§machine-processes}
    parent_session_id INTEGER          CHECK (parent_session_id IS NULL OR parent_session_id != id),
    origin          TEXT    NOT NULL DEFAULT 'client' CHECK (origin IN ('model', 'client', '_plurnk')),
    default_session INTEGER NOT NULL DEFAULT 0 CHECK (default_session IN (0, 1)),
    -- {§session-causal-admission}: cancellation retires unread arrivals without rewriting history.
    cancelled_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_through_sequence >= 0),
    -- The Problem the latest cancellation delivered to this session's live loops; writing it is
    -- the cancellation ({§session-causal-admission}). NULL until the session's scope is first cancelled.
    cancellation TEXT CHECK (cancellation IS NULL OR (json_valid(cancellation) AND json_extract(cancellation, '$.status') = 499)),
    -- {§env-delta}: monotonic observation progress, not a private world snapshot.
    -- Creation captures the workspace high-water; a fork instead copies its
    -- parent's cursor and records the closed event boundary of its snapshot.
    ambient_event_cursor INTEGER      CHECK (ambient_event_cursor IS NULL OR ambient_event_cursor >= 0),
    fork_event_boundary INTEGER       CHECK (fork_event_boundary IS NULL OR fork_event_boundary >= 0),
    owner           TEXT    NOT NULL DEFAULT '_plurnk' CHECK (length(owner) > 0),
    CHECK (fork_event_boundary IS NULL OR parent_session_id IS NOT NULL),
    CHECK (default_session = 0 OR (origin = 'model' AND parent_session_id IS NULL)),
    CHECK ((model_route_id IS NULL) = (effort IS NULL)),
    FOREIGN KEY (workspace_id)      REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)   ON DELETE CASCADE
) STRICT;

CREATE        INDEX IF NOT EXISTS sessions_workspace_id_created_at ON sessions (workspace_id, created_at);

CREATE        INDEX IF NOT EXISTS sessions_parent_session_id       ON sessions (parent_session_id);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_provider_identity       ON sessions (provider_identity);

-- {§session-scheme}: a retained name cannot be rebound to another actor.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_workspace_name          ON sessions (workspace_id, name);

-- {§db-migrations} Foreign-key check paths: without these, updating or replacing a route scans every session.
CREATE INDEX IF NOT EXISTS sessions_model_route_id       ON sessions (model_route_id)       WHERE model_route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_spawn_model_route_id ON sessions (spawn_model_route_id) WHERE spawn_model_route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_owner ON sessions (workspace_id, owner);

CREATE TRIGGER IF NOT EXISTS sessions_provider_identity_immutable
BEFORE UPDATE OF provider_identity ON sessions
WHEN NEW.provider_identity != OLD.provider_identity
BEGIN
    SELECT RAISE(ABORT, 'sessions.provider_identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS sessions_fork_event_boundary_immutable
BEFORE UPDATE OF fork_event_boundary ON sessions
WHEN NEW.fork_event_boundary IS NOT OLD.fork_event_boundary
BEGIN
    SELECT RAISE(ABORT, 'sessions.fork_event_boundary is immutable');
END;

CREATE TRIGGER IF NOT EXISTS session_owner_insert
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

CREATE TRIGGER IF NOT EXISTS session_owner_update
BEFORE UPDATE OF owner, workspace_id ON sessions
WHEN NOT EXISTS (
    SELECT 1 FROM session_owners WHERE workspace_id = NEW.workspace_id AND address = NEW.owner
)
OR (NEW.origin = '_plurnk' AND NEW.owner != '_plurnk')
BEGIN
    SELECT RAISE(ABORT, 'session owner does not belong to its workspace');
END;

CREATE TRIGGER IF NOT EXISTS session_owner_identity
BEFORE UPDATE OF workspace_id, address ON session_owners
BEGIN
    SELECT RAISE(ABORT, 'session owner identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS session_owner_referenced
BEFORE DELETE ON session_owners
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
AND EXISTS (SELECT 1 FROM sessions WHERE workspace_id = OLD.workspace_id AND owner = OLD.address)
BEGIN
    SELECT RAISE(ABORT, 'session owner is still referenced');
END;

-- {§env-delta}: one append-only occurrence journal gives every
-- producer a shared monotonic order. Audience is structural: direct parent,
-- addressed reply, explicit workspace broadcast, or their union. The event snapshots exactly
-- what an observer row needs because source-log curation cannot erase history.
-- source_record_id is forensic identity for the originating log/loop row, not a
-- foreign key: model log curation must not erase an already-recorded occurrence.
CREATE TABLE IF NOT EXISTS ambient_events (
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
            AND op = 'READ'
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

CREATE INDEX IF NOT EXISTS ambient_events_workspace_id_id
    ON ambient_events (workspace_id, id);

-- {§db-migrations} Producer deletion's foreign-key check walks its events by producer; no registry statement selects by it.
CREATE INDEX IF NOT EXISTS ambient_events_producer_kind_id
    ON ambient_events (producer_session_id, kind, id);

CREATE INDEX IF NOT EXISTS ambient_events_parent_id
    ON ambient_events (recipient_session_id, id)
    WHERE recipient_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ambient_events_source_identity
    ON ambient_events (producer_session_id, kind, source_record_id) WHERE kind != 'reply';

CREATE UNIQUE INDEX IF NOT EXISTS ambient_reply_recipient
    ON ambient_events (source_record_id, recipient_session_id) WHERE kind = 'reply';

CREATE TRIGGER IF NOT EXISTS ambient_events_structural_audience
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

-- {§module-lifecycle}: the same provider-validated snapshot, owned by a SESSION rather
-- than a workspace. A family declares which scope its definitions belong to; `env` is the first
-- session-scoped one, because an environment is context (how this session works) rather than
-- capability (what exists in this workspace). A sibling table rather than a nullable column on
-- workspace_module_state: the foreign key is real, so a session's definitions die with it, and
-- every identity component stays NOT NULL ({§db-migrations}).
CREATE TABLE IF NOT EXISTS session_module_state (
    session_id      INTEGER NOT NULL,
    namespace_owner TEXT    NOT NULL CHECK (length(namespace_owner) > 0),
    state           TEXT    NOT NULL CHECK (json_valid(state)),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (session_id, namespace_owner),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

-- {§session-external-reference} Protocol adapters own the opaque key; core owns its durable target.
CREATE TABLE IF NOT EXISTS session_references (
    namespace  TEXT    NOT NULL CHECK (length(namespace) > 0),
    reference  TEXT    NOT NULL,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    PRIMARY KEY (namespace, reference)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS session_references_session ON session_references (session_id);

CREATE TRIGGER IF NOT EXISTS session_reference_identity
BEFORE UPDATE ON session_references
BEGIN
    SELECT RAISE(ABORT, 'session reference is immutable');
END;

CREATE TRIGGER IF NOT EXISTS session_reference_model
BEFORE INSERT ON session_references
WHEN EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id AND origin != 'model')
BEGIN
    SELECT RAISE(ABORT, 'session reference requires a model session');
END;

CREATE VIEW IF NOT EXISTS session_reference_allocations AS
SELECT r.namespace, r.reference, s.name AS workspace_name, w.name AS session_name
FROM session_references r JOIN sessions w ON w.id = r.session_id
JOIN workspaces s ON s.id = w.workspace_id;
