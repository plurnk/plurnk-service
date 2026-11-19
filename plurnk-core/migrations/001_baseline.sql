-- MIGRATE: 1 baseline
-- Re-founded in 9.0.0 ({§db-migrations}): a shape change is the next MIGRATE version, never
-- an edit here.

-- 1. Workspaces: identity, module state, and membership constraints ({§db-migrations}).

-- project_root: workspace pointer. NULL = headless (no disk side-effects);
-- non-null = absolute path to the client's source tree, supplied at workspace.create.
CREATE TABLE workspaces (
    id                        INTEGER NOT NULL PRIMARY KEY,
    name                      TEXT    NOT NULL UNIQUE CHECK (length(name) > 0),
    created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    project_root              TEXT,
    -- {§operator-config} validated client workspace settings; each field composes
    -- with operator configuration at its owning use site.
    settings                  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
    archived_at               TEXT    CHECK (archived_at IS NULL OR length(archived_at) > 0)
) STRICT;

CREATE INDEX workspaces_created_at ON workspaces (created_at);
CREATE INDEX workspaces_project_root ON workspaces (project_root);

-- {§module-lifecycle}: one provider-validated snapshot per workspace.
CREATE TABLE workspace_module_state (
    workspace_id     INTEGER NOT NULL,
    namespace_owner  TEXT    NOT NULL CHECK (length(namespace_owner) > 0),
    state            TEXT    NOT NULL CHECK (json_valid(state)),
    PRIMARY KEY (workspace_id, namespace_owner),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

-- SPEC {§membership} constraint overlay — explicit policy and the inspectable
-- exact pick produced by accepted file creation share one representation.
CREATE TABLE workspace_constraints (
    workspace_id INTEGER NOT NULL,
    -- include admits files git misses; exclude removes members — the members family's lexicon
    -- ({§tools-resource-materialization}). An inclusion is a pattern scan; a creation record is one exact path.
    effect     TEXT    NOT NULL CHECK (effect IN ('include', 'exclude')),
    glob       TEXT    NOT NULL,
    -- create: the exact record of a file Plurnk wrote ({§fs-write-surface}); members: a
    -- human-authored definition projected by the members family; model: a definition the model
    -- proposed under the members scope — never admitted past the repository's ignore rules.
    source     TEXT    NOT NULL CHECK (source IN ('create', 'members', 'model')),
    CHECK (source IN ('members', 'model') OR effect = 'include'),
    PRIMARY KEY (workspace_id, effect, glob),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- 2. Sessions over a workspace, their owners, external references, model routes, and ambient events.

-- model_routes — the immutable resolved model route ({§session-model-selection}). One row per
-- complete resolved tuple; append-only. Alias is provenance plus a tuning scope,
-- not route identity, and is absent on a direct provider/model selection.
CREATE TABLE model_routes (
    id         INTEGER NOT NULL PRIMARY KEY,
    alias      TEXT             CHECK (alias IS NULL OR length(alias) > 0),
    provider   TEXT    NOT NULL CHECK (length(provider) > 0),
    model      TEXT    NOT NULL CHECK (length(model) > 0),
    base_url   TEXT             CHECK (base_url IS NULL OR length(base_url) > 0)
) STRICT;

CREATE UNIQUE INDEX model_routes_identity
ON model_routes (coalesce(alias, ''), provider, model, coalesce(base_url, ''));

-- {§session-ownership}: ownership is durable; an owner states whether
-- a person attends it. The runtime owner (`_plurnk`) holds no client tools and is never interactive.
CREATE TABLE session_owners (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    address      TEXT    NOT NULL CHECK (length(address) > 0),
    tools        TEXT    NOT NULL CHECK (json_valid(tools) AND json_type(tools) = 'array'),
    interactive  INTEGER NOT NULL DEFAULT 0
                         CHECK (interactive IN (0, 1) AND (address != '_plurnk' OR interactive = 0)),
    PRIMARY KEY (workspace_id, address),
    CHECK (address != '_plurnk' OR tools = '[]')
) STRICT;

CREATE TRIGGER session_owner_identity
BEFORE UPDATE OF workspace_id, address ON session_owners
BEGIN
    SELECT RAISE(ABORT, 'session owner identity is immutable');
END;

CREATE TRIGGER session_owner_referenced
BEFORE DELETE ON session_owners
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
AND EXISTS (SELECT 1 FROM sessions WHERE workspace_id = OLD.workspace_id AND owner = OLD.address)
BEGIN
    SELECT RAISE(ABORT, 'session owner is still referenced');
END;

CREATE TABLE sessions (
    id              INTEGER NOT NULL PRIMARY KEY,
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
    -- {§session-model-selection}: durable generation effort policy and whether it was explicitly selected.
    effort          TEXT CHECK (effort IS NULL OR length(effort) > 0),
    effort_source   TEXT NOT NULL DEFAULT 'default' CHECK (effort_source IN ('default', 'explicit')),
    -- sessions fork via parent_session_id; workspaces carry no parent — {§machine-processes}
    parent_session_id INTEGER          CHECK (parent_session_id IS NULL OR parent_session_id != id),
    origin          TEXT    NOT NULL DEFAULT 'client' CHECK (origin IN ('model', 'client', '_plurnk')),
    -- {§session-causal-admission}: cancellation retires unread arrivals without rewriting history.
    cancelled_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_through_sequence >= 0),
    cancellation TEXT CHECK (cancellation IS NULL OR (json_valid(cancellation) AND json_extract(cancellation, '$.status') = 499)),
    -- {§env-delta}: monotonic observation progress, not a private world snapshot.
    ambient_event_cursor INTEGER      CHECK (ambient_event_cursor IS NULL OR ambient_event_cursor >= 0),
    fork_event_boundary INTEGER       CHECK (fork_event_boundary IS NULL OR fork_event_boundary >= 0),
    owner           TEXT    NOT NULL DEFAULT '_plurnk' CHECK (length(owner) > 0),
    archived_at     TEXT CHECK (archived_at IS NULL OR length(archived_at) > 0),
    archived_by     INTEGER REFERENCES sessions(id),
    title           TEXT CHECK (title IS NULL OR length(title) > 0),
    persona         TEXT CHECK (persona IS NULL OR length(persona) > 0),
    CHECK ((archived_at IS NULL) = (archived_by IS NULL)),
    CHECK (fork_event_boundary IS NULL OR parent_session_id IS NOT NULL),
    CHECK ((model_route_id IS NULL) = (effort IS NULL)),
    FOREIGN KEY (workspace_id)      REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)   ON DELETE CASCADE
) STRICT;

CREATE INDEX sessions_workspace_id_created_at ON sessions (workspace_id, created_at);
CREATE INDEX sessions_parent_session_id       ON sessions (parent_session_id);
CREATE UNIQUE INDEX sessions_provider_identity ON sessions (provider_identity);
-- {§session-scheme}: a retained name cannot be rebound to another actor.
CREATE UNIQUE INDEX sessions_workspace_name   ON sessions (workspace_id, name);
-- {§db-migrations} Foreign-key check paths: without these, updating or replacing a route scans every session.
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

-- {§env-delta}: one append-only occurrence journal gives every producer a shared monotonic order.
CREATE TABLE ambient_events (
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
    ON ambient_events (
        COALESCE(json_extract(attrs, '$.messageId'), 0),
        source_record_id,
        recipient_session_id
    ) WHERE kind = 'reply';

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

-- {§module-lifecycle}: provider-validated snapshot owned by a session.
CREATE TABLE session_module_state (
    session_id      INTEGER NOT NULL,
    namespace_owner TEXT    NOT NULL CHECK (length(namespace_owner) > 0),
    state           TEXT    NOT NULL CHECK (json_valid(state)),
    PRIMARY KEY (session_id, namespace_owner),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

-- {§session-external-reference} Protocol adapters own the opaque key; core owns its durable target.
CREATE TABLE session_references (
    namespace  TEXT    NOT NULL CHECK (length(namespace) > 0),
    reference  TEXT    NOT NULL,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    PRIMARY KEY (namespace, reference)
) STRICT, WITHOUT ROWID;

CREATE INDEX session_references_session ON session_references (session_id);

CREATE TRIGGER session_reference_identity
BEFORE UPDATE ON session_references
BEGIN
    SELECT RAISE(ABORT, 'session reference is immutable');
END;

CREATE TRIGGER session_reference_model
BEFORE INSERT ON session_references
WHEN EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id AND origin != 'model')
BEGIN
    SELECT RAISE(ABORT, 'session reference requires a model session');
END;

CREATE VIEW session_reference_allocations AS
SELECT r.namespace, r.reference, s.name AS workspace_name, w.name AS session_name
FROM session_references r JOIN sessions w ON w.id = r.session_id
JOIN workspaces s ON s.id = w.workspace_id;

-- 3. Content store, derivations, full-text index, and native content ({§content-store}).

-- {§content-store} Every settled body is stored once, addressed by its sha256.
-- The ONE engine-imposed constraint (SPEC {§stream}): 100 MiB char-length cap per content body.
CREATE TABLE contents (
    id      INTEGER NOT NULL PRIMARY KEY,
    hash    TEXT    NOT NULL UNIQUE CHECK (length(hash) = 64),
    content TEXT    NOT NULL CHECK (length(content) <= 104857600)
) STRICT;

CREATE TRIGGER contents_immutable
BEFORE UPDATE ON contents
BEGIN
    SELECT RAISE(ABORT, 'content is immutable');
END;

CREATE TABLE derivations (
    id          INTEGER NOT NULL PRIMARY KEY,
    deep_hash   TEXT    NOT NULL UNIQUE CHECK (length(deep_hash) > 0),
    state       TEXT    NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'complete')),
    disposition TEXT    CHECK (disposition IN ('indexed', 'excluded', 'unsearchable', 'failed')),
    reason      TEXT,
    parse_issues INTEGER CHECK (parse_issues IS NULL OR parse_issues > 0),
    -- {§content-store} The text this artifact full-text indexes; NULL = nothing indexed.
    content_id  INTEGER REFERENCES contents(id),
    summary     TEXT    CHECK (
        summary IS NULL OR (
            length(summary) > 0
            AND summary = trim(summary)
            AND instr(summary, char(10)) = 0
            AND instr(summary, char(13)) = 0
        )
    ),
    CHECK ((state = 'building' AND disposition IS NULL) OR (state = 'complete' AND disposition IS NOT NULL))
) STRICT;

-- {§find-result-projection} Native full-text index of the addressed READ body.
-- {§content-store} External content kept in step by the derivation triggers in _entry-fts.sql.
CREATE VIEW derivation_texts AS
SELECT derivations.id AS id, contents.content AS content
FROM derivations
JOIN contents ON contents.id = derivations.content_id;

CREATE VIRTUAL TABLE derivation_fts USING fts5(content, content='derivation_texts', content_rowid='id');

-- {§db-migrations} Content collection asks whether any derivation still indexes a body.
CREATE INDEX derivations_content ON derivations (content_id) WHERE content_id IS NOT NULL;

-- {§log-wire-format}: READ snapshots survive source changes and log curation.
CREATE TABLE native_contents (
    hash TEXT NOT NULL PRIMARY KEY CHECK (length(hash) = 64),
    content BLOB NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TRIGGER native_contents_immutable
BEFORE UPDATE ON native_contents
BEGIN
    SELECT RAISE(ABORT, 'native content is immutable');
END;

-- 4. Loops, notices, turns, messages, and packet composition.

CREATE TABLE loops (
    id       INTEGER NOT NULL PRIMARY KEY,
    session_id   INTEGER NOT NULL,
    sequence INTEGER NOT NULL             CHECK (sequence >= 1),
    status   INTEGER NOT NULL DEFAULT 102 CHECK (status IN (100, 102, 200, 202, 413, 429, 499, 500, 504, 508)),
    prompt   TEXT    NOT NULL,
    -- {§message-arrival}: canonical actor address for the initial message;
    -- NULL means the owning session itself.
    prompt_source TEXT CHECK (prompt_source IS NULL OR length(prompt_source) > 0),
    -- {§session-model-selection}: immutable loop snapshots of the resolved model route and effective spawn route.
    model_route_id       INTEGER          REFERENCES model_routes(id),
    spawn_model_route_id INTEGER          REFERENCES model_routes(id),
    effort           TEXT                 CHECK (effort IS NULL OR length(effort) > 0),
    max_turns        INTEGER NOT NULL     CHECK (max_turns >= -1),
    -- {§session-wait-timing}: initialized on first execution, charged with disposition.
    execution_budget_ms INTEGER CHECK (execution_budget_ms IS NULL OR execution_budget_ms > 0),
    execution_elapsed_ms REAL NOT NULL DEFAULT 0 CHECK (execution_elapsed_ms >= 0),
    -- {§session-wait-timing}: the wait generation; wait_poll_at is the next inherited
    -- observation of the session's open streams ({§exec-lifetime}), epoch milliseconds.
    wait_revision INTEGER NOT NULL DEFAULT 0 CHECK (wait_revision >= 0),
    -- {§engine-rails}: one loop-owned streak and bounded repetition window.
    strike_streak INTEGER NOT NULL DEFAULT 0 CHECK (strike_streak >= 0),
    cycle_history TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cycle_history) AND json_type(cycle_history) = 'array'),
    cycle_wait_revision INTEGER NOT NULL DEFAULT 0 CHECK (cycle_wait_revision >= 0 AND cycle_wait_revision <= wait_revision),
    observed_wake_revision INTEGER NOT NULL DEFAULT 0 CHECK (observed_wake_revision >= 0),
    wait_poll_at INTEGER,
    -- {§message-arrival}: one queued recovery loop may carry the complete unpublished message set of one concluded source loop.
    orphan_source_loop_id INTEGER,
    -- {§session-wait-timing}: first time the loop was claimed to run (status 102).
    claimed_at       TEXT,
    -- {§session-scheme} loop-termination delta: stamped when status crosses into terminal.
    terminated_at    TEXT,
    terminal_result  TEXT,
    -- {§loop-completion}: 'cancel' names an external loop.cancel.
    terminated_by    TEXT                      CHECK (terminated_by IS NULL OR terminated_by = 'cancel'),
    notice_log_cursor INTEGER NOT NULL DEFAULT 0 CHECK (notice_log_cursor >= 0),
    CONSTRAINT loops_generation_policy_contract CHECK (
        (model_route_id IS NULL) = (effort IS NULL)
    ),
    CONSTRAINT loops_terminal_result_contract CHECK (
        CASE
            WHEN status IN (100, 102, 202) THEN terminal_result IS NULL
            WHEN terminal_result IS NULL OR NOT json_valid(terminal_result) THEN 0
            ELSE
                json_type(terminal_result) IS 'object'
                AND json_type(terminal_result, '$.status') IS 'integer'
                AND (
                    json_extract(terminal_result, '$.status') = status
                    OR (
                        status = 200
                        AND json_extract(terminal_result, '$.status') BETWEEN 200 AND 399
                        AND json_extract(terminal_result, '$.status') != 202
                    )
                    OR (
                        status = 500
                        AND json_extract(terminal_result, '$.status') BETWEEN 400 AND 599
                    )
                )
                AND CASE
                    WHEN json_extract(terminal_result, '$.status') < 400 THEN
                        json_type(terminal_result, '$.problem') IS NULL
                    ELSE
                        json_type(terminal_result, '$.problem') IS 'object'
                        AND json_type(terminal_result, '$.problem.status') IS 'integer'
                        AND json_extract(terminal_result, '$.problem.status')
                            = json_extract(terminal_result, '$.status')
                        AND json_type(terminal_result, '$.problem.type') IS 'text'
                        AND length(json_extract(terminal_result, '$.problem.type')) > 0
                        AND json_type(terminal_result, '$.problem.title') IS 'text'
                        AND length(json_extract(terminal_result, '$.problem.title')) > 0
                        AND json_type(terminal_result, '$.problem.detail') IS 'text'
                        AND length(json_extract(terminal_result, '$.problem.detail')) > 0
                        AND json_type(terminal_result, '$.problem.instance') IS 'text'
                        AND length(json_extract(terminal_result, '$.problem.instance')) > 0
                END
        END
    ),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (orphan_source_loop_id) REFERENCES loops(id)
) STRICT;

CREATE UNIQUE INDEX loops_session_id_sequence ON loops (session_id, sequence);
CREATE UNIQUE INDEX loops_orphan_source_loop_id ON loops (orphan_source_loop_id);
-- {§db-migrations} Model-route foreign-key checks stop scanning loops.
CREATE INDEX loops_model_route_id         ON loops (model_route_id)         WHERE model_route_id IS NOT NULL;
CREATE INDEX loops_spawn_model_route_id   ON loops (spawn_model_route_id)   WHERE spawn_model_route_id IS NOT NULL;

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

CREATE TABLE turns (
    id               INTEGER NOT NULL PRIMARY KEY,
    loop_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL           CHECK (sequence >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- {§turn-record}: producer and purpose define the turn.
    producer         TEXT    NOT NULL           CHECK (producer IN ('model', 'client', '_plurnk')),
    kind             TEXT    NOT NULL           CHECK (kind IN ('inference', 'initialization', 'operation', 'maintenance')),
    status           INTEGER NOT NULL           CHECK (status BETWEEN 100 AND 599),
    completed_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Provider-derived curation calibration for this turn; NULL when input capacity is unknown. {§tokenomics}
    usage_curation_budget INTEGER                CHECK (usage_curation_budget IS NULL OR usage_curation_budget >= 0),
    -- {§packet}: NULL means no model request was assembled.
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
    -- Opaque provider→client metadata plus the grammar transport key. {§provider-surface}, {§provider-instantiation}
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

CREATE UNIQUE INDEX turns_loop_id_sequence ON turns (loop_id, sequence);

-- {§turn-record} Producer and purpose never change beneath execution history.
CREATE TRIGGER turns_identity_forward_only
BEFORE UPDATE OF producer, kind ON turns
WHEN NOT (
    OLD.producer = NEW.producer
    AND OLD.kind = NEW.kind
)
BEGIN
    SELECT RAISE(ABORT, 'turn producer and kind are immutable');
END;

-- {§message-arrival}: the loop's inbox.
CREATE TABLE loop_messages (
    id              INTEGER NOT NULL PRIMARY KEY,
    loop_id         INTEGER NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
    ordinal         INTEGER NOT NULL CHECK (ordinal >= 1),
    message_key     TEXT NOT NULL DEFAULT (lower(hex(randomblob(4)))),
    address         TEXT CHECK (address IS NULL OR length(address) > 0),
    -- {§message-arrival}: NULL means the owning session itself.
    source          TEXT CHECK (source IS NULL OR length(source) > 0),
    body            TEXT NOT NULL CHECK (length(body) > 0),
    evidence        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence) AND json_type(evidence) = 'object'),
    -- {§methods-workspace-create}: the message's selected paths (string[] JSON), read at publication.
    open_paths      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_paths)),
    -- The inbound send row this message became; NULL until published.
    log_entry_id    INTEGER,
    -- {§loop-completion}: a message a session's own operation sends records that operation by turn and sequence.
    opened_turn_id  INTEGER REFERENCES turns(id) ON DELETE SET NULL,
    opened_sequence INTEGER CHECK (opened_sequence IS NULL OR opened_sequence >= 1),
    UNIQUE (loop_id, ordinal)
);

CREATE INDEX loop_messages_unpublished ON loop_messages (loop_id) WHERE log_entry_id IS NULL;
CREATE INDEX loop_messages_address ON loop_messages (address) WHERE address IS NOT NULL;
CREATE INDEX loop_messages_opener ON loop_messages (opened_turn_id, opened_sequence) WHERE opened_turn_id IS NOT NULL;

-- {§message-source-scheme}: an address identifies exactly one accepted source in its workspace.
CREATE TRIGGER loop_messages_address_unique
BEFORE INSERT ON loop_messages
WHEN NEW.address IS NOT NULL AND EXISTS (
    SELECT 1 FROM loop_messages m
    JOIN loops l ON l.id = m.loop_id
    JOIN sessions w ON w.id = l.session_id
    WHERE m.address = NEW.address AND w.workspace_id = (
        SELECT w2.workspace_id FROM loops l2 JOIN sessions w2 ON w2.id = l2.session_id
        WHERE l2.id = NEW.loop_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'message address already accepted in this workspace');
END;

CREATE TRIGGER loop_messages_immutable_source
BEFORE UPDATE OF message_key, address, source, body, evidence, open_paths ON loop_messages
BEGIN
    SELECT RAISE(ABORT, 'accepted message source is immutable');
END;

CREATE TRIGGER loop_messages_delete_with_history_only
BEFORE DELETE ON loop_messages
WHEN EXISTS (SELECT 1 FROM loops WHERE id = OLD.loop_id)
BEGIN
    SELECT RAISE(ABORT, 'accepted messages can only be removed with their containing history');
END;

-- {§message-arrival}: scope message_key uniqueness to the receiving session.
CREATE TRIGGER loop_messages_key_unique
BEFORE INSERT ON loop_messages
WHEN EXISTS (
    SELECT 1 FROM loop_messages m
    JOIN loops l ON l.id = m.loop_id
    WHERE m.message_key = NEW.message_key AND l.session_id = (
        SELECT l2.session_id FROM loops l2 WHERE l2.id = NEW.loop_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'message_key already accepted in this session');
END;

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

-- {§message-arrival}: `key_path` is the model's address for a message; `path` stays the durable identity.
CREATE VIEW message_sources AS
SELECT m.*, w.workspace_id, w.id AS session_id,
       'message://' || w.name || '/' || m.message_key AS key_path,
       COALESCE(m.address, 'message://' || w.name || '/' || m.message_key) AS path
FROM loop_messages m
JOIN loops l ON l.id = m.loop_id
JOIN sessions w ON w.id = l.session_id;

CREATE VIEW message_senders AS
SELECT m.id AS message_id, sender.session_id AS sender_session_id
FROM loop_messages m
JOIN turns opened ON opened.id = m.opened_turn_id
JOIN loops sender ON sender.id = opened.loop_id;

-- {§session-initialization-entry}: derived observation only; no durable row is rewritten.
CREATE VIEW work_loops AS
SELECT l.* FROM loops l
WHERE NOT EXISTS (SELECT 1 FROM turns t WHERE t.loop_id = l.id AND t.kind = 'maintenance')
   OR EXISTS (SELECT 1 FROM turns t WHERE t.loop_id = l.id AND t.kind <> 'maintenance');

-- {§packet}: a packet's sections are rows over content-addressed items.
CREATE TABLE packet_items (
    hash TEXT NOT NULL PRIMARY KEY CHECK (length(hash) = 64),
    text TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- {§packet-assembly}: section slots include system, user, and assistant.
CREATE TABLE turn_sections (
    turn_id  INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    name     TEXT    NOT NULL CHECK (length(name) > 0),
    slot     TEXT    NOT NULL CHECK (slot IN ('system', 'user', 'assistant')),
    header   TEXT,
    weight   INTEGER NOT NULL CHECK (weight >= 0),
    PRIMARY KEY (turn_id, position),
    UNIQUE (turn_id, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE turn_section_items (
    turn_id   INTEGER NOT NULL,
    section   INTEGER NOT NULL,
    position  INTEGER NOT NULL CHECK (position >= 0),
    item_hash TEXT    NOT NULL REFERENCES packet_items(hash),
    PRIMARY KEY (turn_id, section, position),
    FOREIGN KEY (turn_id, section) REFERENCES turn_sections(turn_id, position) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- {§db-migrations}: item collection and the packet_items foreign-key check path.
CREATE INDEX turn_section_items_item_hash ON turn_section_items (item_hash);

-- {§packet}: the one write of inference evidence.
CREATE VIEW turn_inference_evidence AS
SELECT NULL AS turn_id, NULL AS packet, NULL AS sections,
       NULL AS usage_curation_budget, NULL AS finish_reason, NULL AS model, NULL AS meta
WHERE 0;

CREATE TRIGGER turn_inference_evidence_insert
INSTEAD OF INSERT ON turn_inference_evidence
BEGIN
    SELECT RAISE(ABORT, 'turn is not an open model inference turn')
    WHERE NOT EXISTS (
        SELECT 1 FROM turns
        WHERE id = NEW.turn_id AND producer = 'model' AND kind = 'inference'
          AND completed_at IS NULL AND packet IS NULL
    );
    SELECT RAISE(ABORT, 'packet sections must be a JSON array of {name, slot, header, weight, items}')
    WHERE json_type(NEW.sections) IS NOT 'array';
    INSERT OR IGNORE INTO packet_items (hash, text)
    SELECT sha256(item.value), item.value
    FROM json_each(NEW.sections) AS section, json_each(section.value, '$.items') AS item;
    INSERT INTO turn_sections (turn_id, position, name, slot, header, weight)
    SELECT NEW.turn_id, section.key,
           json_extract(section.value, '$.name'), json_extract(section.value, '$.slot'),
           json_extract(section.value, '$.header'), json_extract(section.value, '$.weight')
    FROM json_each(NEW.sections) AS section;
    INSERT INTO turn_section_items (turn_id, section, position, item_hash)
    SELECT NEW.turn_id, section.key, item.key, sha256(item.value)
    FROM json_each(NEW.sections) AS section, json_each(section.value, '$.items') AS item;
    UPDATE turns
    SET packet = NEW.packet,
        usage_curation_budget = NEW.usage_curation_budget,
        finish_reason = NEW.finish_reason,
        model = NEW.model,
        meta = NEW.meta
    WHERE id = NEW.turn_id;
END;

-- {§packet}: a turn as its readers know it — the packet bag with its sections assembled back into it.
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

-- 5. Inference: logical calls, model responses, emission attempts, physical provider requests, and turn sources.

-- One logical model call owns its lifecycle and physical-request ledger. {§tokenomics}
CREATE TABLE inference_calls (
    id                  INTEGER NOT NULL PRIMARY KEY,
    workspace_id        INTEGER NOT NULL,
    turn_id             INTEGER NOT NULL,
    sequence            INTEGER NOT NULL CHECK (sequence >= 1),
    kind                TEXT    NOT NULL CHECK (kind IN ('emission', 'bare')),
    state               TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'response', 'error')),
    attributions        TEXT    NOT NULL DEFAULT '[]' CHECK (
        json_valid(attributions) AND json_type(attributions) = 'array'
    ),
    request_model       TEXT    NOT NULL CHECK (length(request_model) >= 1),
    timestamp           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at        TEXT,
    -- {§content-store}: one logical call owns retirement of all its captured payloads.
    payloads_retired_at TEXT,
    CHECK (
        (state = 'pending' AND completed_at IS NULL)
        OR (state IN ('response', 'error') AND completed_at IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX inference_calls_turn_sequence
    ON inference_calls (turn_id, sequence);

CREATE INDEX inference_calls_workspace_id
    ON inference_calls (workspace_id, timestamp, id);

CREATE TRIGGER inference_calls_open_pending
BEFORE INSERT ON inference_calls
WHEN NEW.state != 'pending' OR NEW.completed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'inference call must open pending');
END;

CREATE TRIGGER inference_calls_context_valid
BEFORE INSERT ON inference_calls
WHEN COALESCE((
    SELECT w.workspace_id = NEW.workspace_id
        AND t.producer = 'model' AND t.kind = 'inference'
    FROM turns t
    JOIN loops l ON l.id = t.loop_id
    JOIN sessions w ON w.id = l.session_id
    WHERE t.id = NEW.turn_id
), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'inference call requires a valid owning workspace and causal context');
END;

CREATE TRIGGER inference_calls_request_identity_immutable
BEFORE UPDATE OF workspace_id, turn_id, sequence, kind, attributions, request_model, timestamp
ON inference_calls
BEGIN
    SELECT RAISE(ABORT, 'inference call request identity is immutable');
END;

CREATE TRIGGER inference_calls_state_forward_only
BEFORE UPDATE OF state ON inference_calls
WHEN NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'pending' AND NEW.state IN ('response', 'error'))
)
BEGIN
    SELECT RAISE(ABORT, 'inference call state may only close once');
END;

CREATE TRIGGER inference_calls_terminal_evidence_required
BEFORE UPDATE OF state ON inference_calls
WHEN NEW.state != OLD.state
 AND NOT (
    (NEW.state = 'response'
     AND EXISTS (SELECT 1 FROM model_call_responses WHERE id = NEW.id)
     AND EXISTS (SELECT 1 FROM model_calls WHERE id = NEW.id AND capacity IS NOT NULL AND response_model IS NOT NULL))
    OR
    (NEW.state = 'error'
     AND EXISTS (SELECT 1 FROM model_calls WHERE id = NEW.id AND failure IS NOT NULL AND json_array_length(native_inputs) = 0))
 )
BEGIN
    SELECT RAISE(ABORT, 'inference call terminal state requires specialization evidence');
END;

CREATE TRIGGER inference_calls_completion_immutable
BEFORE UPDATE OF completed_at ON inference_calls
WHEN OLD.state != 'pending'
BEGIN
    SELECT RAISE(ABORT, 'inference call completion is immutable');
END;

CREATE TRIGGER inference_payload_retirement_insert
BEFORE INSERT ON inference_calls WHEN NEW.payloads_retired_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'inference payloads cannot open retired');
END;

CREATE TRIGGER inference_payload_retirement_once
BEFORE UPDATE OF payloads_retired_at ON inference_calls
WHEN OLD.payloads_retired_at IS NOT NULL OR NEW.payloads_retired_at IS NULL
  OR NEW.state = 'pending'
  OR NOT EXISTS (SELECT 1 FROM turns WHERE id = NEW.turn_id AND completed_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM provider_requests WHERE inference_call_id = NEW.id AND state = 'pending')
BEGIN
    SELECT RAISE(ABORT, 'inference payload retirement requires completed work and occurs once');
END;

CREATE TABLE model_calls (
    id               INTEGER NOT NULL PRIMARY KEY,
    -- {§log-wire-format}: exact model-facing log coordinates whose native bytes were present in this completed request.
    native_inputs    TEXT    NOT NULL DEFAULT '[]' CHECK (
        json_valid(native_inputs) AND json_type(native_inputs) = 'array'
    ),
    failure          TEXT             CHECK (failure IS NULL OR json_valid(failure)),
    capacity         TEXT             CHECK (
        capacity IS NULL OR (json_valid(capacity) AND json_type(capacity) = 'object')
    ),
    finish_reason    TEXT,
    response_model   TEXT             CHECK (response_model IS NULL OR length(response_model) >= 1),
    FOREIGN KEY (id) REFERENCES inference_calls(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER model_calls_specializes_generation
BEFORE INSERT ON model_calls
WHEN COALESCE((
    SELECT kind IN ('emission', 'bare') FROM inference_calls WHERE id = NEW.id
), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'model call must specialize a generation inference');
END;

CREATE TRIGGER model_calls_cannot_orphan_inference
AFTER DELETE ON model_calls
WHEN EXISTS (SELECT 1 FROM inference_calls WHERE id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'model call specialization cannot be deleted independently');
END;

CREATE TRIGGER model_calls_observation_pending
BEFORE UPDATE OF native_inputs, failure, capacity, finish_reason, response_model
ON model_calls
WHEN COALESCE((SELECT state FROM inference_calls WHERE id = OLD.id), '') != 'pending'
BEGIN
    SELECT RAISE(ABORT, 'model call observation is immutable');
END;

-- Response body separated so retention ({§content-store}) can retire payloads while keeping call evidence.
CREATE TABLE model_call_responses (
    id       INTEGER NOT NULL PRIMARY KEY,
    response TEXT    NOT NULL CHECK (json_valid(response)),
    FOREIGN KEY (id) REFERENCES model_calls(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER model_call_responses_immutable
BEFORE UPDATE ON model_call_responses
BEGIN
    SELECT RAISE(ABORT, 'model call response is immutable');
END;

CREATE VIEW model_call_observation AS
SELECT mc.id, mc.native_inputs, r.response, mc.failure, mc.capacity, mc.finish_reason, mc.response_model
FROM model_calls mc LEFT JOIN model_call_responses r ON r.id = mc.id
WHERE 0;

CREATE TRIGGER model_call_observation_settles
INSTEAD OF INSERT ON model_call_observation
BEGIN
    SELECT CASE WHEN COALESCE((SELECT state FROM inference_calls WHERE id = NEW.id), '') != 'pending'
        THEN RAISE(ABORT, 'model call observation is immutable') END;
    UPDATE model_calls
    SET native_inputs = COALESCE(NEW.native_inputs, native_inputs),
        failure = NEW.failure,
        capacity = COALESCE(NEW.capacity, capacity),
        finish_reason = NEW.finish_reason,
        response_model = NEW.response_model
    WHERE id = NEW.id;
    INSERT INTO model_call_responses (id, response)
    SELECT NEW.id, NEW.response WHERE NEW.response IS NOT NULL;
    UPDATE inference_calls
    SET state = CASE WHEN NEW.response IS NOT NULL THEN 'response' ELSE 'error' END,
        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.id;
END;

CREATE TABLE turn_attempts (
    id               INTEGER NOT NULL PRIMARY KEY,
    model_call_id    INTEGER NOT NULL UNIQUE,
    accepted         INTEGER          CHECK (accepted IS NULL OR accepted IN (0, 1)),
    parse_errors     TEXT    NOT NULL DEFAULT '[]' CHECK (
        json_valid(parse_errors) AND json_type(parse_errors) = 'array'
    ),
    FOREIGN KEY (model_call_id) REFERENCES model_calls(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER turn_attempts_request_identity_immutable
BEFORE UPDATE OF model_call_id ON turn_attempts
BEGIN
    SELECT RAISE(ABORT, 'emission attempt identity is immutable');
END;

CREATE TRIGGER turn_attempts_emission_call_only
BEFORE INSERT ON turn_attempts
WHEN COALESCE((SELECT kind = 'emission' FROM inference_calls WHERE id = NEW.model_call_id), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'turn attempt requires an emission model call');
END;

CREATE TRIGGER turn_attempts_classification_after_response
BEFORE UPDATE OF accepted, parse_errors ON turn_attempts
WHEN COALESCE((SELECT state = 'response' FROM inference_calls WHERE id = OLD.model_call_id), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'emission classification requires model response evidence');
END;

CREATE TRIGGER turn_attempts_classification_once
BEFORE UPDATE OF accepted, parse_errors
ON turn_attempts
WHEN OLD.accepted IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'emission attempt classification is immutable');
END;

CREATE TRIGGER turn_attempts_one_accepted_insert
BEFORE INSERT ON turn_attempts
WHEN NEW.accepted = 1 AND EXISTS (
    SELECT 1
    FROM turn_attempts existing
    JOIN inference_calls old_call ON old_call.id = existing.model_call_id
    JOIN inference_calls new_call ON new_call.id = NEW.model_call_id
    WHERE old_call.turn_id = new_call.turn_id AND existing.accepted = 1
)
BEGIN
    SELECT RAISE(ABORT, 'one emission may be accepted per turn');
END;

CREATE TRIGGER turn_attempts_one_accepted_update
BEFORE UPDATE OF accepted ON turn_attempts
WHEN NEW.accepted = 1 AND EXISTS (
    SELECT 1
    FROM turn_attempts existing
    JOIN inference_calls old_call ON old_call.id = existing.model_call_id
    JOIN inference_calls new_call ON new_call.id = NEW.model_call_id
    WHERE old_call.turn_id = new_call.turn_id
      AND existing.id != OLD.id
      AND existing.accepted = 1
)
BEGIN
    SELECT RAISE(ABORT, 'one emission may be accepted per turn');
END;

-- {§provider-request-accounting}: one row is opened before one physical provider request and settled once.
CREATE TABLE provider_requests (
    id                       INTEGER NOT NULL PRIMARY KEY,
    inference_call_id        INTEGER NOT NULL,
    sequence                 INTEGER NOT NULL CHECK (sequence >= 1),
    provider                 TEXT    NOT NULL CHECK (length(provider) > 0),
    model                    TEXT    NOT NULL CHECK (length(model) > 0),
    state                    TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'settled')),
    outcome                  TEXT             CHECK (outcome IN ('response', 'error')),
    status                   INTEGER          CHECK (status IS NULL OR status BETWEEN 100 AND 599),
    usage_input              INTEGER          CHECK (usage_input IS NULL OR usage_input >= 0),
    usage_output             INTEGER          CHECK (usage_output IS NULL OR usage_output >= 0),
    usage_total              INTEGER          CHECK (usage_total IS NULL OR usage_total >= 0),
    usage_input_no_cache     INTEGER          CHECK (usage_input_no_cache IS NULL OR usage_input_no_cache >= 0),
    usage_input_cache_read   INTEGER          CHECK (usage_input_cache_read IS NULL OR usage_input_cache_read >= 0),
    usage_input_cache_write  INTEGER          CHECK (usage_input_cache_write IS NULL OR usage_input_cache_write >= 0),
    usage_output_text        INTEGER          CHECK (usage_output_text IS NULL OR usage_output_text >= 0),
    usage_output_reasoning   INTEGER          CHECK (usage_output_reasoning IS NULL OR usage_output_reasoning >= 0),
    cost_kind                TEXT             CHECK (cost_kind IN ('charged', 'estimated', 'unknown')),
    cost_amount              TEXT,
    cost_currency            TEXT,
    cost_usd_equivalent      TEXT,
    cost_source              TEXT,
    cost_reason              TEXT,
    started_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at             TEXT,
    -- {§provider-request-accounting}: physical request/response payload evidence.
    evidence                 TEXT             CHECK (evidence IS NULL OR json_valid(evidence)),
    CHECK (
        (state = 'pending'
            AND outcome IS NULL AND status IS NULL
            AND usage_input IS NULL AND usage_output IS NULL AND usage_total IS NULL
            AND usage_input_no_cache IS NULL AND usage_input_cache_read IS NULL
            AND usage_input_cache_write IS NULL AND usage_output_text IS NULL
            AND usage_output_reasoning IS NULL
            AND cost_kind IS NULL AND cost_amount IS NULL AND cost_currency IS NULL
            AND cost_usd_equivalent IS NULL AND cost_source IS NULL AND cost_reason IS NULL
            AND completed_at IS NULL)
        OR
        (state = 'settled' AND outcome IS NOT NULL AND cost_kind IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CHECK (
        cost_amount IS NULL OR (
            length(cost_amount) > 0
            AND cost_amount NOT GLOB '*[^0-9.]*'
            AND cost_amount NOT LIKE '.%'
            AND cost_amount NOT LIKE '%.'
            AND cost_amount NOT LIKE '%.%.%'
            AND (cost_amount = '0' OR cost_amount NOT GLOB '0[0-9]*')
        )
    ),
    CHECK (
        cost_usd_equivalent IS NULL OR (
            length(cost_usd_equivalent) > 0
            AND cost_usd_equivalent NOT GLOB '*[^0-9.]*'
            AND cost_usd_equivalent NOT LIKE '.%'
            AND cost_usd_equivalent NOT LIKE '%.'
            AND cost_usd_equivalent NOT LIKE '%.%.%'
            AND (cost_usd_equivalent = '0' OR cost_usd_equivalent NOT GLOB '0[0-9]*')
        )
    ),
    CHECK (
        cost_currency IS NULL OR (
            length(cost_currency) BETWEEN 3 AND 12
            AND substr(cost_currency, 1, 1) GLOB '[A-Z]'
            AND cost_currency NOT GLOB '*[^A-Z0-9]*'
        )
    ),
    CHECK (
        cost_kind IS NULL
        OR (cost_kind = 'charged'
            AND cost_amount IS NOT NULL AND cost_currency IS NOT NULL
            AND cost_source IS NOT NULL AND length(cost_source) > 0
            AND cost_reason IS NULL)
        OR (cost_kind = 'estimated'
            AND cost_amount IS NOT NULL AND cost_currency IS NOT NULL
            AND cost_usd_equivalent IS NULL
            AND cost_source IS NOT NULL AND length(cost_source) > 0
            AND cost_reason IS NULL)
        OR (cost_kind = 'unknown'
            AND cost_amount IS NULL AND cost_currency IS NULL
            AND cost_usd_equivalent IS NULL AND cost_source IS NULL
            AND cost_reason IS NOT NULL AND length(cost_reason) > 0)
    ),
    UNIQUE (inference_call_id, sequence),
    FOREIGN KEY (inference_call_id) REFERENCES inference_calls(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER provider_requests_pending_inference_only
BEFORE INSERT ON provider_requests
WHEN COALESCE((SELECT state = 'pending' FROM inference_calls WHERE id = NEW.inference_call_id), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'provider request requires a pending inference call');
END;

CREATE TRIGGER provider_requests_identity_immutable
BEFORE UPDATE OF inference_call_id, sequence, provider, model, started_at
ON provider_requests
BEGIN
    SELECT RAISE(ABORT, 'provider request identity is immutable');
END;

CREATE TRIGGER provider_requests_state_forward_only
BEFORE UPDATE OF state ON provider_requests
WHEN NOT (NEW.state = OLD.state OR (OLD.state = 'pending' AND NEW.state = 'settled'))
BEGIN
    SELECT RAISE(ABORT, 'provider request may only settle once');
END;

CREATE TRIGGER provider_requests_settlement_immutable
BEFORE UPDATE OF outcome, status,
                 usage_input, usage_output, usage_total,
                 usage_input_no_cache, usage_input_cache_read, usage_input_cache_write,
                 usage_output_text, usage_output_reasoning,
                 cost_kind, cost_amount, cost_currency, cost_usd_equivalent,
                 cost_source, cost_reason, completed_at
ON provider_requests
WHEN OLD.state != 'pending'
BEGIN
    SELECT RAISE(ABORT, 'provider request settlement is immutable');
END;

CREATE TRIGGER provider_request_payload_immutable
BEFORE UPDATE OF evidence ON provider_requests
WHEN OLD.state <> 'pending' AND NOT (
    OLD.evidence IS NOT NULL AND NEW.evidence IS NULL
    AND EXISTS (SELECT 1 FROM inference_calls WHERE id = OLD.inference_call_id AND payloads_retired_at IS NOT NULL)
)
BEGIN
    SELECT RAISE(ABORT, 'provider request payload is immutable except through retention');
END;

-- {§turn-source-resources} {§outside-text}: immutable source facts belong to their turn, interned into contents ({§content-store}).
CREATE TABLE turn_source_rows (
    turn_id       INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL CHECK (kind IN ('ops', 'reasoning', 'note', 'outside')),
    sequence      INTEGER NOT NULL DEFAULT 0 CHECK ((kind = 'note' AND sequence > 0) OR (kind != 'note' AND sequence = 0)),
    content_id    INTEGER NOT NULL REFERENCES contents(id),
    model_call_id INTEGER REFERENCES model_calls(id),
    deep_hash     TEXT    REFERENCES derivations(deep_hash),
    PRIMARY KEY (turn_id, kind, sequence)
) STRICT, WITHOUT ROWID;

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

-- 6. Entries, channels, and symbol graph ({§db-migrations}).

CREATE TABLE entries (
    id         INTEGER NOT NULL PRIMARY KEY,
    scheme     TEXT    NOT NULL             CHECK (length(scheme) > 0),
    authority  TEXT    NOT NULL DEFAULT '',
    pathname   TEXT    NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    attributes TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
    default_channel TEXT NOT NULL DEFAULT 'body' CHECK (length(default_channel) > 0),
    output INTEGER NOT NULL DEFAULT 0 CHECK (output IN (0, 1)),
    -- SPEC {§membership} / {§membership-auto-add}: how a file member entered the curated surface.
    membership_origin TEXT                   CHECK (membership_origin IS NULL OR membership_origin IN ('git', 'constraint')),
    -- SPEC {§file-snapshot-revision}: per-member sync revision of the disk file at its last materialization.
    synced_sig TEXT,
    -- Last-modified stamp bumped on addressable representation changes so the catalog keeps dormant entries at the prefix.
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- {§execution-output-identity}: one canonical resource key.
CREATE UNIQUE INDEX entries_identity ON entries (workspace_id, scheme, authority, pathname);

CREATE TABLE entry_channel_rows (
    entry_id INTEGER NOT NULL,
    name     TEXT    NOT NULL             CHECK (length(name) > 0),
    content_id INTEGER REFERENCES contents(id),
    buffer   TEXT                         CHECK (buffer IS NULL OR length(buffer) <= 104857600),
    mimetype TEXT    NOT NULL             CHECK (length(mimetype) > 0),
    weight   INTEGER NOT NULL DEFAULT 0   CHECK (weight >= 0),
    -- ({§tokenomics}, {§mimetype-error-policy}).
    lines    INTEGER NOT NULL             CHECK (lines >= 0),
    deep_hash TEXT,
    state    TEXT    NOT NULL DEFAULT 'static' CHECK (state IN ('static', 'active', 'closed', 'errored')),
    producer_result TEXT,
    CONSTRAINT entry_channel_producer_result_contract CHECK (
        CASE
            WHEN producer_result IS NULL THEN 1
            WHEN NOT json_valid(producer_result) THEN 0
            ELSE
                json_type(producer_result) IS 'object'
                AND json_type(producer_result, '$.status') IS 'integer'
                AND json_extract(producer_result, '$.status') BETWEEN 200 AND 599
                AND json_extract(producer_result, '$.status') != 202
                AND CASE
                    WHEN json_extract(producer_result, '$.status') < 400 THEN
                        json_type(producer_result, '$.problem') IS NULL
                    ELSE
                        json_type(producer_result, '$.problem') IS 'object'
                        AND json_type(producer_result, '$.problem.status') IS 'integer'
                        AND json_extract(producer_result, '$.problem.status')
                            = json_extract(producer_result, '$.status')
                        AND json_type(producer_result, '$.problem.type') IS 'text'
                        AND length(json_extract(producer_result, '$.problem.type')) > 0
                        AND json_type(producer_result, '$.problem.title') IS 'text'
                        AND length(json_extract(producer_result, '$.problem.title')) > 0
                        AND json_type(producer_result, '$.problem.detail') IS 'text'
                        AND length(json_extract(producer_result, '$.problem.detail')) > 0
                END
        END
    ),
    CHECK ((content_id IS NULL) <> (buffer IS NULL)),
    PRIMARY KEY (entry_id, name),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (deep_hash) REFERENCES derivations(deep_hash)
) STRICT, WITHOUT ROWID;

CREATE INDEX entry_channel_rows_deep_hash ON entry_channel_rows (deep_hash) WHERE deep_hash IS NOT NULL;
CREATE INDEX entry_channel_rows_content ON entry_channel_rows (content_id) WHERE content_id IS NOT NULL;

-- {§content-store} The channel as every reader and writer sees it.
CREATE VIEW entry_channels AS
SELECT entry_channel_rows.entry_id, entry_channel_rows.name,
       COALESCE(entry_channel_rows.buffer, contents.content) AS content,
       entry_channel_rows.mimetype, entry_channel_rows.weight, entry_channel_rows.lines,
       contents.hash AS content_hash, entry_channel_rows.deep_hash, entry_channel_rows.state,
       entry_channel_rows.producer_result
FROM entry_channel_rows
LEFT JOIN contents ON contents.id = entry_channel_rows.content_id;

-- {§mimetype-error-policy}: `entry_channels.lines` mirrors `TextCoordinates.lineCount`.
CREATE TRIGGER entry_channels_insert
INSTEAD OF INSERT ON entry_channels
BEGIN
    SELECT RAISE(ABORT, 'a channel requires content') WHERE NEW.content IS NULL;
    SELECT RAISE(ABORT, 'content_hash does not match content')
    WHERE NEW.content_hash IS NOT NULL AND NEW.content_hash IS NOT sha256(NEW.content);
    INSERT INTO contents (hash, content)
    SELECT COALESCE(NEW.content_hash, sha256(NEW.content)), NEW.content
    WHERE COALESCE(NEW.state, 'static') <> 'active'
    ON CONFLICT (hash) DO NOTHING;
    INSERT INTO entry_channel_rows (entry_id, name, content_id, buffer, mimetype, weight, lines, deep_hash, state, producer_result)
    VALUES (
        NEW.entry_id, NEW.name,
        CASE WHEN COALESCE(NEW.state, 'static') <> 'active'
             THEN (SELECT id FROM contents WHERE hash = COALESCE(NEW.content_hash, sha256(NEW.content))) END,
        CASE WHEN COALESCE(NEW.state, 'static') = 'active' THEN NEW.content END,
        NEW.mimetype, COALESCE(NEW.weight, 0),
        CASE WHEN length(NEW.content) = 0 THEN 0
             ELSE length(NEW.content) - length(replace(NEW.content, char(10), ''))
                + length(NEW.content) - length(replace(NEW.content, char(13), ''))
                - (length(NEW.content) - length(replace(NEW.content, char(13) || char(10), ''))) / 2
                + CASE WHEN substr(NEW.content, -1) IN (char(10), char(13)) THEN 0 ELSE 1 END END,
        NEW.deep_hash, COALESCE(NEW.state, 'static'), NEW.producer_result
    );
END;

CREATE TRIGGER entry_channels_update
INSTEAD OF UPDATE ON entry_channels
BEGIN
    SELECT RAISE(ABORT, 'a channel is addressed by (entry_id, name)')
    WHERE NEW.entry_id IS NOT OLD.entry_id OR NEW.name IS NOT OLD.name;
    SELECT RAISE(ABORT, 'a channel requires content') WHERE NEW.content IS NULL;
    SELECT RAISE(ABORT, 'content_hash does not match content')
    WHERE NEW.content_hash IS NOT NULL AND NEW.content_hash IS NOT OLD.content_hash
      AND NEW.content_hash IS NOT sha256(NEW.content);
    INSERT INTO contents (hash, content)
    SELECT sha256(NEW.content), NEW.content
    WHERE NEW.state <> 'active' AND (NEW.content IS NOT OLD.content OR OLD.state = 'active')
    ON CONFLICT (hash) DO NOTHING;
    UPDATE entry_channel_rows
    SET content_id = CASE WHEN NEW.state <> 'active'
                          THEN (SELECT id FROM contents WHERE hash = sha256(NEW.content)) END,
        buffer = CASE WHEN NEW.state = 'active' THEN NEW.content END,
        lines = CASE WHEN length(NEW.content) = 0 THEN 0
             ELSE length(NEW.content) - length(replace(NEW.content, char(10), ''))
                + length(NEW.content) - length(replace(NEW.content, char(13), ''))
                - (length(NEW.content) - length(replace(NEW.content, char(13) || char(10), ''))) / 2
                + CASE WHEN substr(NEW.content, -1) IN (char(10), char(13)) THEN 0 ELSE 1 END END
    WHERE entry_id = OLD.entry_id AND name = OLD.name
      AND (NEW.content IS NOT OLD.content OR (NEW.state = 'active') IS NOT (OLD.state = 'active'));
    UPDATE entry_channel_rows
    SET mimetype = NEW.mimetype, weight = NEW.weight, state = NEW.state, producer_result = NEW.producer_result
    WHERE entry_id = OLD.entry_id AND name = OLD.name
      AND (NEW.mimetype IS NOT OLD.mimetype OR NEW.weight IS NOT OLD.weight
           OR NEW.state IS NOT OLD.state OR NEW.producer_result IS NOT OLD.producer_result);
    UPDATE entry_channel_rows
    SET deep_hash = NEW.deep_hash
    WHERE entry_id = OLD.entry_id AND name = OLD.name AND NEW.deep_hash IS NOT OLD.deep_hash;
END;

CREATE TRIGGER entry_channels_delete
INSTEAD OF DELETE ON entry_channels
BEGIN
    DELETE FROM entry_channel_rows WHERE entry_id = OLD.entry_id AND name = OLD.name;
END;

-- {§scheme-manifest} {§file-snapshot-revision} A publication is one SQL statement.
CREATE VIEW entry_publication AS
SELECT NULL AS workspace_id, NULL AS scheme, NULL AS authority, NULL AS pathname,
       NULL AS attributes, NULL AS default_channel, NULL AS output,
       NULL AS channels, NULL AS created, NULL AS synced_sig
WHERE 0;

CREATE TRIGGER entry_publication_insert
INSTEAD OF INSERT ON entry_publication
BEGIN
    SELECT CASE WHEN json_type(NEW.channels) IS NOT 'object'
        THEN RAISE(ABORT, 'entry publication requires a channel object') END;
    INSERT INTO entries (workspace_id, scheme, authority, pathname, attributes, default_channel, output, synced_sig)
    VALUES (NEW.workspace_id, NEW.scheme, NEW.authority, NEW.pathname,
            COALESCE(NEW.attributes, '{}'), NEW.default_channel, NEW.output, NEW.synced_sig)
    ON CONFLICT (workspace_id, scheme, authority, pathname) DO UPDATE SET
        attributes = COALESCE(NEW.attributes, entries.attributes),
        default_channel = excluded.default_channel,
        output = MAX(entries.output, excluded.output),
        synced_sig = excluded.synced_sig;
    DELETE FROM entry_channels WHERE entry_id = (
        SELECT id FROM entries WHERE workspace_id = NEW.workspace_id
          AND scheme = NEW.scheme AND authority = NEW.authority AND pathname = NEW.pathname
    ) AND name NOT IN (SELECT key FROM json_each(NEW.channels));
    UPDATE entry_channels
    SET content = json_extract(c.value, '$.content'),
        mimetype = json_extract(c.value, '$.mimetype'),
        weight = json_extract(c.value, '$.weight'),
        content_hash = json_extract(c.value, '$.content_hash'),
        state = json_extract(c.value, '$.state'),
        producer_result = json_extract(c.value, '$.producer_result')
    FROM (SELECT key, value FROM json_each(NEW.channels)) AS c
    WHERE entry_channels.name = c.key
      AND entry_channels.entry_id = (
        SELECT id FROM entries WHERE workspace_id = NEW.workspace_id
          AND scheme = NEW.scheme AND authority = NEW.authority AND pathname = NEW.pathname
      );
    INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, state, producer_result)
    SELECT e.id, c.key, json_extract(c.value, '$.content'), json_extract(c.value, '$.mimetype'),
           json_extract(c.value, '$.weight'), json_extract(c.value, '$.content_hash'),
           json_extract(c.value, '$.state'), json_extract(c.value, '$.producer_result')
    FROM entries e, json_each(NEW.channels) c
    WHERE e.workspace_id = NEW.workspace_id AND e.scheme = NEW.scheme
      AND e.authority = NEW.authority AND e.pathname = NEW.pathname
      AND NOT EXISTS (SELECT 1 FROM entry_channel_rows r WHERE r.entry_id = e.id AND r.name = c.key);
END;

-- &graph NODES ({§matcher-dispatch}).
CREATE TABLE symbol_defs (
    id            INTEGER NOT NULL PRIMARY KEY,
    derivation_id INTEGER NOT NULL,
    name          TEXT    NOT NULL CHECK (length(name) > 0),
    kind          TEXT    NOT NULL,
    container     TEXT,
    line          INTEGER NOT NULL,
    end_line      INTEGER,
    column        INTEGER,
    end_column    INTEGER CHECK (
        (column IS NULL AND end_column IS NULL)
        OR (column >= 1 AND end_column >= 1 AND column IS NOT NULL AND end_column IS NOT NULL
            AND end_line IS NOT NULL AND (end_line > line OR (end_line = line AND end_column >= column)))
    ),
    FOREIGN KEY (derivation_id) REFERENCES derivations(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX symbol_defs_name   ON symbol_defs (name);
CREATE INDEX symbol_defs_source ON symbol_defs (derivation_id);

-- &graph EDGES ({§matcher-dispatch}).
CREATE TABLE symbol_refs (
    id            INTEGER NOT NULL PRIMARY KEY,
    derivation_id INTEGER NOT NULL REFERENCES derivations(id) ON DELETE CASCADE,
    name          TEXT    NOT NULL CHECK (length(name) > 0),
    kind          TEXT    NOT NULL,
    container     TEXT,
    line          INTEGER NOT NULL CHECK (line >= 1),
    column        INTEGER NOT NULL CHECK (column >= 1),
    end_line      INTEGER NOT NULL,
    end_column    INTEGER NOT NULL CHECK (end_column >= 1),
    CHECK (end_line > line OR (end_line = line AND end_column >= column))
) STRICT;

CREATE INDEX symbol_refs_name   ON symbol_refs (name);
CREATE INDEX symbol_refs_source ON symbol_refs (derivation_id, container);

-- 7. Subscriptions and publication cursors ({§subscriptions}).

CREATE TABLE subscriptions (
    id                INTEGER NOT NULL PRIMARY KEY,
    session_id        INTEGER,
    entry_id          INTEGER NOT NULL,
    scheme            TEXT    NOT NULL CHECK (length(scheme) > 0),
    handle            TEXT    NOT NULL CHECK (length(handle) > 0),
    published_channel TEXT             CHECK (published_channel IS NULL OR length(published_channel) > 0),
    source            TEXT             CHECK (source IS NULL OR length(source) > 0),
    opened_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- {§loop-completion} / {§exec-lifetime}: a detached spawn outlives its loop and is nobody's obligation.
    detached          INTEGER NOT NULL DEFAULT 0 CHECK (detached IN (0, 1)),
    closed_at         TEXT,
    close_status      INTEGER          CHECK (close_status IS NULL OR (close_status BETWEEN 100 AND 599)),
    close_result      TEXT             CHECK (close_result IS NULL OR json_valid(close_result)),
    channel_results   TEXT             CHECK (channel_results IS NULL OR json_valid(channel_results)),
    -- {§child-orientation}: last output activity timestamp on this stream.
    output_changed_at TEXT,
    CHECK ((closed_at IS NULL AND close_status IS NULL AND close_result IS NULL AND channel_results IS NULL)
        OR (closed_at IS NOT NULL AND close_status IS NOT NULL AND close_result IS NOT NULL AND channel_results IS NOT NULL)),
    CHECK (session_id IS NOT NULL OR closed_at IS NOT NULL),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (entry_id)   REFERENCES entries(id)  ON DELETE CASCADE
) STRICT;

CREATE TRIGGER subscriptions_workspace_insert
BEFORE INSERT ON subscriptions
WHEN NOT EXISTS (
    SELECT 1 FROM entries e
    JOIN sessions caller ON caller.id = NEW.session_id
    WHERE e.id = NEW.entry_id AND e.workspace_id = caller.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'subscription and resource must share a workspace');
END;

CREATE TRIGGER subscriptions_identity_update
BEFORE UPDATE OF session_id, entry_id, scheme, source ON subscriptions
WHEN NEW.entry_id != OLD.entry_id OR NEW.scheme != OLD.scheme OR NEW.source IS NOT OLD.source
  OR (NEW.session_id IS NOT OLD.session_id AND NOT (NEW.session_id IS NULL AND NEW.closed_at IS NOT NULL))
BEGIN
    SELECT RAISE(ABORT, 'subscription identity is immutable');
END;

CREATE UNIQUE INDEX subscriptions_active_one_per_entry
    ON subscriptions (entry_id)
    WHERE closed_at IS NULL;

CREATE INDEX subscriptions_session_id ON subscriptions (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX subscriptions_entry_id   ON subscriptions (entry_id);

CREATE TRIGGER subscriptions_result_contract_insert
BEFORE INSERT ON subscriptions
WHEN NEW.closed_at IS NOT NULL
  OR NEW.close_status IS NOT NULL
  OR NEW.close_result IS NOT NULL
  OR NEW.channel_results IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'subscription must open before it can settle');
END;

CREATE TRIGGER subscriptions_result_contract_update
BEFORE UPDATE OF closed_at, close_status, close_result, channel_results ON subscriptions
WHEN NOT (
    (NEW.closed_at IS NULL AND NEW.close_status IS NULL AND NEW.close_result IS NULL AND NEW.channel_results IS NULL)
    OR (
        NEW.closed_at IS NOT NULL
        AND NEW.close_status IS NOT NULL
        AND NEW.close_result IS NOT NULL
        AND NEW.channel_results IS NOT NULL
        AND json_valid(NEW.channel_results)
        AND json_type(NEW.channel_results) = 'object'
        AND CASE
            WHEN NOT json_valid(NEW.close_result) THEN 0
            ELSE
                json_type(NEW.close_result) IS 'object'
                AND json_type(NEW.close_result, '$.status') IS 'integer'
                AND json_extract(NEW.close_result, '$.status') BETWEEN 200 AND 599
                AND json_extract(NEW.close_result, '$.status') != 202
                AND json_extract(NEW.close_result, '$.status') = NEW.close_status
                AND CASE
                    WHEN json_extract(NEW.close_result, '$.status') < 400 THEN
                        json_type(NEW.close_result, '$.problem') IS NULL
                    ELSE
                        json_type(NEW.close_result, '$.problem') IS 'object'
                        AND json_type(NEW.close_result, '$.problem.status') IS 'integer'
                        AND json_extract(NEW.close_result, '$.problem.status')
                            = json_extract(NEW.close_result, '$.status')
                        AND json_type(NEW.close_result, '$.problem.type') IS 'text'
                        AND length(json_extract(NEW.close_result, '$.problem.type')) > 0
                        AND json_type(NEW.close_result, '$.problem.title') IS 'text'
                        AND length(json_extract(NEW.close_result, '$.problem.title')) > 0
                        AND json_type(NEW.close_result, '$.problem.detail') IS 'text'
                        AND length(json_extract(NEW.close_result, '$.problem.detail')) > 0
                END
        END
    )
)
BEGIN
    SELECT RAISE(ABORT, 'subscription terminal result violates the operation-result contract');
END;

CREATE TRIGGER subscriptions_channel_results_contract
BEFORE UPDATE OF closed_at, close_status, close_result, channel_results ON subscriptions
WHEN NEW.closed_at IS NOT NULL AND (
    EXISTS (
        SELECT 1
        FROM json_each(NEW.channel_results) AS channel_result
        LEFT JOIN entry_channels ec
          ON ec.entry_id = NEW.entry_id AND ec.name = channel_result.key
        WHERE ec.name IS NULL
           OR json_type(channel_result.value) != 'object'
           OR json_type(channel_result.value, '$.status') != 'integer'
           OR json_extract(channel_result.value, '$.status') NOT BETWEEN 200 AND 599
           OR json_extract(channel_result.value, '$.status') = 202
           OR (
                json_extract(channel_result.value, '$.status') < 400
                AND json_type(channel_result.value, '$.problem') IS NOT NULL
           )
           OR (
                json_extract(channel_result.value, '$.status') >= 400
                AND (
                    json_type(channel_result.value, '$.problem') != 'object'
                    OR json_extract(channel_result.value, '$.problem.status')
                        != json_extract(channel_result.value, '$.status')
                )
           )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'subscription channel result violates the channel producer contract');
END;

-- {§exec-stream}: publication cursors survive curation of generated observations.
CREATE TABLE subscription_publications (
    id                 INTEGER NOT NULL PRIMARY KEY,
    subscription_id    INTEGER NOT NULL,
    channel            TEXT    NOT NULL CHECK (length(channel) > 0),
    published_end      INTEGER NOT NULL DEFAULT 0 CHECK (published_end >= 0),
    terminal_published INTEGER NOT NULL DEFAULT 0 CHECK (terminal_published IN (0, 1)),
    UNIQUE (subscription_id, channel),
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX subscription_publications_pending
    ON subscription_publications (subscription_id, terminal_published);

-- 8. Log rows, projections, curation effects, proposals, message completions, obligations, and interactions.

-- {§content-store} {§operation-results} {§path-syntax} {§log-wire-format}: append-only execution evidence interned into contents.
CREATE TABLE log_entry_rows (
    id              INTEGER NOT NULL PRIMARY KEY,
    session_id      INTEGER NOT NULL,
    loop_id         INTEGER NOT NULL,
    turn_id         INTEGER NOT NULL,
    sequence        INTEGER NOT NULL           CHECK (sequence >= 1),
    at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    origin          TEXT    NOT NULL           CHECK (origin IN ('model', 'client', '_plurnk')),
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
    -- {§tokenomics}
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

CREATE UNIQUE INDEX log_entry_rows_turn_id_sequence ON log_entry_rows (turn_id, sequence);
CREATE INDEX log_entry_rows_session_id ON log_entry_rows (session_id);
CREATE INDEX log_entry_rows_loop_id ON log_entry_rows (loop_id);
CREATE INDEX log_entry_rows_deep_hash ON log_entry_rows (deep_hash) WHERE deep_hash IS NOT NULL;
CREATE INDEX log_entry_rows_pending_derivation ON log_entry_rows (session_id, id) WHERE deep_hash IS NULL;
CREATE UNIQUE INDEX log_entry_rows_model_call_id ON log_entry_rows (model_call_id) WHERE model_call_id IS NOT NULL;
CREATE INDEX log_entry_rows_subscription_publication_id ON log_entry_rows (subscription_publication_id) WHERE subscription_publication_id IS NOT NULL;
CREATE UNIQUE INDEX log_entry_rows_session_ambient_event ON log_entry_rows (session_id, ambient_event_id) WHERE ambient_event_id IS NOT NULL;
CREATE INDEX log_entry_rows_ambient_event_id ON log_entry_rows (ambient_event_id) WHERE ambient_event_id IS NOT NULL;
-- {§turn-source-resources}: one announcement per turn.
CREATE UNIQUE INDEX log_entry_rows_emission_turn ON log_entry_rows (turn_id) WHERE json_extract(attrs, '$.kind') = 'emission';
CREATE INDEX log_entry_rows_tx_content ON log_entry_rows (tx_content_id);
CREATE INDEX log_entry_rows_rx_content ON log_entry_rows (rx_content_id);
CREATE INDEX log_entry_rows_patch_content ON log_entry_rows (patch_content_id) WHERE patch_content_id IS NOT NULL;
CREATE INDEX log_entry_rows_native_content_hash ON log_entry_rows (native_content_hash) WHERE native_content_hash IS NOT NULL;

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
 AND NEW.origin IN ('model', 'client', '_plurnk')
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

-- {§message-completion}: message outcome is independent of reply delivery and log curation.
CREATE TABLE message_completions (
    message_id  INTEGER PRIMARY KEY REFERENCES loop_messages(id) ON DELETE CASCADE,
    response_id INTEGER REFERENCES log_entry_rows(id) ON DELETE SET NULL,
    status      INTEGER NOT NULL CHECK (status IN (200, 499))
) STRICT;

CREATE INDEX message_completions_response_id
    ON message_completions (response_id) WHERE response_id IS NOT NULL;

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

-- {§message-completion}: delivered messages remain executed evidence.
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

CREATE VIEW message_responses AS
SELECT DISTINCT r.id, m.loop_id, m.session_id, r.source, r.content, r.rx
FROM log_responses r
JOIN sessions producer ON producer.id = r.session_id
JOIN json_each(r.rx, '$.repliedTo') reply
JOIN message_sources m ON m.key_path = reply.value AND m.workspace_id = producer.workspace_id
UNION ALL
SELECT r.id, r.loop_id, r.session_id, r.source, r.content, r.rx
FROM log_responses r WHERE json_array_length(r.rx, '$.repliedTo') = 0;

CREATE VIEW unanswered_messages AS
SELECT m.* FROM message_sources m
WHERE NOT EXISTS (SELECT 1 FROM message_completions c WHERE c.message_id = m.id);

-- {§message-arrival}: a reply reaches the message's own session and the session that sent it.
CREATE VIEW message_reply_deliveries AS
SELECT DISTINCT r.id AS source_record_id, r.loop_id, m.workspace_id,
       r.session_id AS producer_session_id, m.session_id AS recipient_session_id
FROM log_responses r
JOIN sessions producer ON producer.id = r.session_id
JOIN json_each(r.rx, '$.repliedTo') reply
JOIN message_sources m ON m.key_path = reply.value AND m.workspace_id = producer.workspace_id
UNION
SELECT r.id, r.loop_id, m.workspace_id, r.session_id, s.sender_session_id
FROM log_responses r
JOIN sessions producer ON producer.id = r.session_id
JOIN json_each(r.rx, '$.repliedTo') reply
JOIN message_sources m ON m.key_path = reply.value AND m.workspace_id = producer.workspace_id
JOIN message_senders s ON s.message_id = m.id;

-- {§session-scheme}: a child's answer to the first message its parent sent is its conclusion, not a reply.
CREATE VIEW delegated_task_replies AS
SELECT r.id AS source_record_id, producer.parent_session_id AS recipient_session_id
FROM log_responses r
JOIN sessions producer ON producer.id = r.session_id
JOIN json_each(r.rx, '$.repliedTo') reply
JOIN message_sources m ON m.key_path = reply.value AND m.workspace_id = producer.workspace_id
JOIN message_senders s ON s.message_id = m.id
WHERE m.loop_id = r.loop_id AND m.ordinal = 1 AND s.sender_session_id = producer.parent_session_id;

CREATE VIEW delivered_message_replies AS
SELECT d.* FROM message_reply_deliveries d
WHERE NOT EXISTS (
    SELECT 1 FROM delegated_task_replies t
    WHERE t.source_record_id = d.source_record_id AND t.recipient_session_id = d.recipient_session_id
);

-- {§loop-completion}: a session is held on its open streams, live children, and unanswered messages sent to live recipient loops.
CREATE VIEW session_obligations AS
SELECT w.id AS session_id,
       EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.session_id = w.id AND s.closed_at IS NULL AND s.detached = 0
       ) AS streams,
       EXISTS (
           SELECT 1 FROM sessions c JOIN loops l ON l.session_id = c.id
           WHERE c.parent_session_id = w.id AND l.status IN (100, 102, 202)
       ) AS sessions,
       EXISTS (
           SELECT 1 FROM message_senders s
           JOIN loop_messages m ON m.id = s.message_id
           JOIN loops l ON l.id = m.loop_id
           WHERE s.sender_session_id = w.id
             AND l.status IN (100, 102, 202)
             AND NOT EXISTS (SELECT 1 FROM message_completions c WHERE c.message_id = m.id)
       ) AS messages
FROM sessions w;

CREATE VIEW loop_obligations AS
SELECT l.id AS loop_id, held.streams, held.sessions, held.messages
FROM loops l JOIN session_obligations held ON held.session_id = l.session_id;

-- {§log-history-projection}: current model-facing projection of log_entries.
CREATE TABLE log_entry_projections (
    log_entry_id INTEGER NOT NULL PRIMARY KEY,
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    folded       TEXT    NOT NULL DEFAULT '[]'
                         CHECK (json_valid(folded) AND json_type(folded) = 'array'),
    FOREIGN KEY (log_entry_id) REFERENCES log_entry_rows(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

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

-- {§turn-source-resources} An emission is curated whole: its projection is retired, never trimmed.
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

-- {§log-kill-scope}: durable curation effects.
CREATE TABLE log_curation_effects (
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

CREATE INDEX log_curation_effects_target ON log_curation_effects (target_log_entry_id);

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

-- {§proposal}: authority precedes effects; results cannot replace decisions.
CREATE TABLE proposal_decisions (
    log_entry_id INTEGER PRIMARY KEY REFERENCES log_entry_rows(id) ON DELETE CASCADE,
    decision     TEXT NOT NULL CHECK (decision IN ('accept', 'reject', 'cancel')),
    resolver     TEXT NOT NULL CHECK (length(resolver) > 0),
    body         TEXT,
    outcome      TEXT,
    decided_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

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

-- {§proposal-projection}: durable discoverable half of a client-owned interaction.
CREATE TABLE client_interactions (
    id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL,
    loop_id      INTEGER NOT NULL,
    turn_id      INTEGER NOT NULL,
    request      TEXT    NOT NULL CHECK (json_valid(request) AND json_type(request) = 'object'),
    recipient    TEXT    NOT NULL DEFAULT '_plurnk',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (loop_id)    REFERENCES loops(id)    ON DELETE CASCADE,
    FOREIGN KEY (turn_id)    REFERENCES turns(id)    ON DELETE CASCADE
) STRICT;

CREATE INDEX client_interactions_session_id_id
    ON client_interactions (session_id, id);
CREATE INDEX client_interactions_loop_id ON client_interactions (loop_id);
CREATE INDEX client_interactions_turn_id ON client_interactions (turn_id);
