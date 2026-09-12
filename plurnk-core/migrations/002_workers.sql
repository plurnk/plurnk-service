-- MIGRATE: 2 workers
-- Chapter 2 of the schema baseline ({§db-schema-baseline}): Workers over a workspace, their model routes, and the ambient event feed their siblings observe.
-- Version numbers order the chapters on a fresh database; they are not history. A shape
-- change edits the chapter in place; existing development databases are recreated.

-- model_routes — the immutable resolved model route ({§worker-model-selection}). One row per
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

-- workers
CREATE TABLE IF NOT EXISTS workers (
    id              INTEGER NOT NULL PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    workspace_id    INTEGER NOT NULL,
    -- {§loop-wake-identity}: completion events, not packet/log curation state.
    wake_revision   INTEGER NOT NULL DEFAULT 0 CHECK (wake_revision >= 0),
    name            TEXT    NOT NULL CHECK (length(name) > 0),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- {§worker-provider-identity}: provider affinity must not collide when
    -- independent databases reuse local integer ids.
    provider_identity TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
        CHECK (length(provider_identity) = 32 AND provider_identity NOT GLOB '*[^0-9a-f]*'),
    -- {§worker-model-selection}: the worker's durable resolved model, NULL for non-model
    -- workers or a deliberately modelless unresolved worker. spawn_model_route_id is the
    -- persistent spawn override; NULL means "use my model."
    model_route_id       INTEGER          REFERENCES model_routes(id),
    spawn_model_route_id INTEGER          REFERENCES model_routes(id),
    -- {§worker-reasoning-policy}: nullable only while the worker has no model;
    -- once selected, model and reasoning policy form one durable generation policy.
    reasoning_policy TEXT CHECK (reasoning_policy IS NULL OR length(reasoning_policy) > 0),
    -- {§worker-reasoning-source}: whether reasoning_policy was chosen (worker.reasoning.set)
    -- or seeded from the alias configuration; a default never masquerades as a choice.
    reasoning_source TEXT NOT NULL DEFAULT 'default' CHECK (reasoning_source IN ('default', 'explicit')),
    -- workers fork via parent_worker_id; workspaces carry no parent — {§machine-processes-no-fork-workspace}
    parent_worker_id INTEGER          CHECK (parent_worker_id IS NULL OR parent_worker_id != id),
    origin          TEXT    NOT NULL DEFAULT 'client' CHECK (origin IN ('model', 'client', '_plurnk')),
    -- {§methods-model-worker}: durable identity for the workspace's stable
    -- default conversation; separate from its literal name.
    default_conversation INTEGER NOT NULL DEFAULT 0 CHECK (default_conversation IN (0, 1)),
    -- {§worker-causal-admission}: cancellation retires unread arrivals without rewriting history.
    cancelled_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_through_sequence >= 0),
    -- {§env-delta-log-pull}: monotonic observation progress, not a private world snapshot.
    -- Creation captures the workspace high-water; a fork instead copies its
    -- parent's cursor and records the closed event boundary of its snapshot.
    ambient_event_cursor INTEGER      CHECK (ambient_event_cursor IS NULL OR ambient_event_cursor >= 0),
    fork_event_boundary INTEGER       CHECK (fork_event_boundary IS NULL OR fork_event_boundary >= 0),
    CHECK (fork_event_boundary IS NULL OR parent_worker_id IS NOT NULL),
    CHECK (default_conversation = 0 OR (origin = 'model' AND parent_worker_id IS NULL)),
    CHECK ((model_route_id IS NULL) = (reasoning_policy IS NULL)),
    FOREIGN KEY (workspace_id)    REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_worker_id) REFERENCES workers(id)     ON DELETE CASCADE
) STRICT;

CREATE        INDEX IF NOT EXISTS workers_workspace_id_created_at ON workers (workspace_id, created_at);

CREATE        INDEX IF NOT EXISTS workers_parent_worker_id         ON workers (parent_worker_id);

CREATE UNIQUE INDEX IF NOT EXISTS workers_provider_identity         ON workers (provider_identity);

CREATE UNIQUE INDEX IF NOT EXISTS workers_workspace_default_conversation
    ON workers (workspace_id) WHERE default_conversation = 1;

-- {§worker-scheme-spawn}: a retained name cannot be rebound to another actor.
CREATE UNIQUE INDEX IF NOT EXISTS workers_workspace_name          ON workers (workspace_id, name);

-- {§db-fk-indexes} Foreign-key check paths: without these, updating or replacing a route scans every worker.
CREATE INDEX IF NOT EXISTS workers_model_route_id       ON workers (model_route_id)       WHERE model_route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS workers_spawn_model_route_id ON workers (spawn_model_route_id) WHERE spawn_model_route_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS workers_provider_identity_immutable
BEFORE UPDATE OF provider_identity ON workers
WHEN NEW.provider_identity != OLD.provider_identity
BEGIN
    SELECT RAISE(ABORT, 'workers.provider_identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS workers_fork_event_boundary_immutable
BEFORE UPDATE OF fork_event_boundary ON workers
WHEN NEW.fork_event_boundary IS NOT OLD.fork_event_boundary
BEGIN
    SELECT RAISE(ABORT, 'workers.fork_event_boundary is immutable');
END;

-- {§env-delta-log-pull}: one append-only occurrence journal gives every
-- producer a shared monotonic order. Audience is structural: direct parent,
-- explicit workspace broadcast, or their union. The event snapshots exactly
-- what an observer row needs because source-log curation cannot erase history.
-- source_record_id is forensic identity for the originating log/loop row, not a
-- foreign key: model log curation must not erase an already-recorded occurrence.
CREATE TABLE IF NOT EXISTS ambient_events (
    id                      INTEGER NOT NULL PRIMARY KEY,
    workspace_id            INTEGER NOT NULL,
    producer_worker_id      INTEGER NOT NULL,
    target_parent_worker_id INTEGER,
    workspace_broadcast     INTEGER NOT NULL DEFAULT 0 CHECK (workspace_broadcast IN (0, 1)),
    kind                    TEXT    NOT NULL CHECK (kind IN ('activity', 'loop_termination')),
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
    CHECK (target_parent_worker_id IS NOT NULL OR workspace_broadcast = 1),
    CHECK (
        (kind = 'activity' AND terminated_by IS NULL)
        OR
        (kind = 'loop_termination'
            AND op = 'SEND'
            -- {§env-delta-child-termination}: a message from the concluded child;
            -- `source` names the actor and its READ address (#567, operator 2026-09-07).
            AND scheme IS NULL
            AND pathname IS NULL
            AND json_valid(rx)
            AND json_type(rx) = 'object'
            AND json_type(rx, '$.status') = 'integer'
            AND json_extract(rx, '$.status') = status_rx)
    ),
    FOREIGN KEY (workspace_id)            REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (producer_worker_id)      REFERENCES workers(id)    ON DELETE CASCADE,
    FOREIGN KEY (target_parent_worker_id) REFERENCES workers(id)    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS ambient_events_workspace_id_id
    ON ambient_events (workspace_id, id);

-- {§db-index-owners} Producer deletion's foreign-key check walks its events by producer; no registry statement selects by it.
CREATE INDEX IF NOT EXISTS ambient_events_producer_kind_id
    ON ambient_events (producer_worker_id, kind, id);

CREATE INDEX IF NOT EXISTS ambient_events_parent_id
    ON ambient_events (target_parent_worker_id, id)
    WHERE target_parent_worker_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ambient_events_source_identity
    ON ambient_events (producer_worker_id, kind, source_record_id);

CREATE TRIGGER IF NOT EXISTS ambient_events_structural_audience
BEFORE INSERT ON ambient_events
WHEN NOT EXISTS (
    SELECT 1
    FROM workers producer
    WHERE producer.id = NEW.producer_worker_id
      AND producer.workspace_id = NEW.workspace_id
      AND (
          NEW.target_parent_worker_id IS NULL
          OR NEW.target_parent_worker_id = producer.parent_worker_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'ambient event audience must be the producer direct parent in the same workspace');
END;
