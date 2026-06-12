-- INIT: sessions
-- project_root: workspace pointer. NULL = headless (no disk side-effects);
-- non-null = absolute path to the client's source tree, supplied at
-- session.create or session.set_root.
-- persona: head of the persona cascade (loops.persona > runs.persona >
-- sessions.persona > PATHS.defaultPersona). Nullable; null falls through.
CREATE TABLE IF NOT EXISTS sessions (
    id                        INTEGER NOT NULL PRIMARY KEY,
    version                   INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    name                      TEXT    NOT NULL UNIQUE CHECK (length(name) > 0),
    created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cost_pico                 INTEGER NOT NULL DEFAULT 0 CHECK (cost_pico >= 0),
    scheme_registry_additions TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(scheme_registry_additions)),
    project_root              TEXT,
    persona                   TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions (created_at);

-- INIT: runs
-- persona: middle of the persona cascade (loops > runs > sessions > default).
-- Nullable; null falls through to the session level.
CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER NOT NULL PRIMARY KEY,
    version       INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    session_id    INTEGER NOT NULL,
    name          TEXT    NOT NULL CHECK (length(name) > 0),
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    parent_run_id INTEGER          CHECK (parent_run_id IS NULL OR parent_run_id != id),
    cost_pico     INTEGER NOT NULL DEFAULT 0 CHECK (cost_pico >= 0),
    persona       TEXT,
    FOREIGN KEY (session_id)    REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_run_id) REFERENCES runs(id)     ON DELETE CASCADE
) STRICT;

CREATE        INDEX IF NOT EXISTS runs_session_id_created_at ON runs (session_id, created_at);
CREATE        INDEX IF NOT EXISTS runs_parent_run_id         ON runs (parent_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS runs_session_name          ON runs (session_id, name);

-- INIT: loops
-- flags: per-loop runtime flags (yolo, noProposals, noWeb, noInteraction,
-- mode). JSON column, merged over DEFAULT_LOOP_FLAGS in code so missing
-- keys read as their defaults. SchemeRegistry.resolveForLoop gates schemes
-- by manifest affinity (proposes / excludedInAsk / requiresWeb / etc).
-- persona: head of the cascade (loops > runs > sessions > default).
CREATE TABLE IF NOT EXISTS loops (
    id       INTEGER NOT NULL PRIMARY KEY,
    version  INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    run_id   INTEGER NOT NULL,
    sequence INTEGER NOT NULL             CHECK (sequence >= 1),
    status   INTEGER NOT NULL DEFAULT 102 CHECK (status IN (100, 102, 200, 499)),
    prompt   TEXT    NOT NULL,
    flags    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(flags)),
    persona  TEXT,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS loops_run_id_sequence ON loops (run_id, sequence);

-- INIT: turns
-- finish_reason / model: provider-call metadata (plurnk-grammar Turn.json).
-- Properties of the call, not of the model's emission payload — kept on
-- the Turn row alongside usage rather than nested into packet.assistant.
CREATE TABLE IF NOT EXISTS turns (
    id               INTEGER NOT NULL PRIMARY KEY,
    version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    loop_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL           CHECK (sequence >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    status           INTEGER NOT NULL           CHECK (status BETWEEN 100 AND 599),
    usage_prompt     INTEGER NOT NULL DEFAULT 0 CHECK (usage_prompt >= 0),
    usage_completion INTEGER NOT NULL DEFAULT 0 CHECK (usage_completion >= 0),
    usage_cached     INTEGER NOT NULL DEFAULT 0 CHECK (usage_cached >= 0),
    usage_cost_pico  INTEGER NOT NULL DEFAULT 0 CHECK (usage_cost_pico >= 0),
    packet           TEXT    NOT NULL           CHECK (json_valid(packet)),
    finish_reason    TEXT,
    model            TEXT    NOT NULL DEFAULT 'unknown' CHECK (length(model) >= 1),
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS turns_loop_id_sequence ON turns (loop_id, sequence);
CREATE        INDEX IF NOT EXISTS turns_timestamp        ON turns (timestamp);

-- INIT: entries
-- The canonical addressable store. (scope, scheme, pathname) is the
-- identity tuple. scheme is nullable: the `file` scheme is a routing
-- internal only, never stored here; bare/file paths land with scheme=NULL.
CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER NOT NULL PRIMARY KEY,
    version    INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    scope      TEXT    NOT NULL             CHECK (scope IN ('agent', 'session')),
    session_id INTEGER,
    scheme     TEXT                         CHECK (scheme IS NULL OR length(scheme) > 0),
    username   TEXT,
    password   TEXT,
    hostname   TEXT,
    port       INTEGER                      CHECK (port IS NULL OR (port BETWEEN 0 AND 65535)),
    pathname   TEXT    NOT NULL,
    params     TEXT                         CHECK (params IS NULL OR json_valid(params)),
    attributes TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
    -- SPEC §14.3 — how a file member entered the curated surface. 'git' rows are
    -- reconciled against `git ls-files − ignore` each turn (registered + un-registered
    -- so entries == members); 'client'/'constraint' (model-created, add-glob) are not
    -- git's to reclaim. NULL = not a file member (other schemes don't carry origin).
    membership_origin TEXT                   CHECK (membership_origin IS NULL OR membership_origin IN ('git', 'client', 'constraint')),
    -- @graph / ~semantic change-gate (#186): hash of the body content at the last
    -- deep-channel derivation. The manifest-add pass re-derives symbols/refs (and
    -- embeddings, later) ONLY when this differs from the current body hash — an
    -- unchanged entry is skipped, never re-metadatafied every turn.
    deep_hash TEXT,
    CHECK ((scope = 'agent'   AND session_id IS NULL)
        OR (scope = 'session' AND session_id IS NOT NULL)),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS entries_agent_identity   ON entries (scheme, pathname)             WHERE scope = 'agent';
CREATE UNIQUE INDEX IF NOT EXISTS entries_session_identity ON entries (session_id, scheme, pathname) WHERE scope = 'session';

-- The ONE engine-imposed constraint (SPEC §7.8): 100 MiB char-length cap
-- per channel content body. All other limits are extrinsic.
CREATE TABLE IF NOT EXISTS entry_channels (
    entry_id INTEGER NOT NULL,
    name     TEXT    NOT NULL             CHECK (length(name) > 0),
    content  TEXT    NOT NULL             CHECK (length(content) <= 104857600),
    mimetype TEXT    NOT NULL             CHECK (length(mimetype) > 0),
    tokens   INTEGER NOT NULL DEFAULT 0   CHECK (tokens >= 0),
    state    TEXT    NOT NULL DEFAULT 'static' CHECK (state IN ('static', 'active', 'closed', 'errored')),
    PRIMARY KEY (entry_id, name),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id INTEGER NOT NULL,
    tag      TEXT    NOT NULL CHECK (length(tag) > 0),
    PRIMARY KEY (entry_id, tag),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS entry_tags_tag ON entry_tags (tag);

-- INIT: symbol_defs
-- @graph NODES (plurnk-service#186). Code symbol definitions, populated
-- delete-then-insert per entry at write (EntryCrud.writeEntry) from mimetypes'
-- `symbols` channel. Qualified path = container ? container || '.' || name : name.
CREATE TABLE IF NOT EXISTS symbol_defs (
    id         INTEGER NOT NULL PRIMARY KEY,
    session_id INTEGER NOT NULL,
    entry_id   INTEGER NOT NULL,
    name       TEXT    NOT NULL CHECK (length(name) > 0),
    kind       TEXT    NOT NULL,
    container  TEXT,
    line       INTEGER NOT NULL,
    end_line   INTEGER,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS symbol_defs_name ON symbol_defs (session_id, name);

-- INIT: symbol_refs
-- @graph EDGES (plurnk-service#186), from mimetypes' `references` channel.
-- name = edge TARGET; container = the SOURCE def's full qualified path (the
-- @> join key; module-level → NULL); kind ∈ import|call|instantiate|inherit|
-- type|use (frozen, edge metadata only — traversal is kind-agnostic).
CREATE TABLE IF NOT EXISTS symbol_refs (
    id         INTEGER NOT NULL PRIMARY KEY,
    session_id INTEGER NOT NULL,
    entry_id   INTEGER NOT NULL,
    name       TEXT    NOT NULL CHECK (length(name) > 0),
    kind       TEXT    NOT NULL,
    container  TEXT,
    line       INTEGER NOT NULL,
    col        INTEGER,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS symbol_refs_name   ON symbol_refs (session_id, name);
CREATE INDEX IF NOT EXISTS symbol_refs_source ON symbol_refs (session_id, entry_id, container);

-- INIT: entry_fts (~semantic FTS half — plurnk-service#186)
-- Keyword/content index over entry body content; the FTS5 rowid IS entries.id.
-- The ~semantic dialect narrows candidates here (cheap, indexed) then cosine-ranks
-- the narrowed set over the embedding vectors — FTS does the scale-cut, cosine the
-- precise rank, so no ANN/extension is needed. Populated at the gated manifest-add
-- hook alongside symbol_defs/refs: re-indexed only when body content changes.
CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(content);

-- INIT: log_entries
-- Chronological event store. sequence is 1-based, scoped to the turn —
-- resets at each new turn. URI-bit columns are unprefixed (scheme,
-- pathname, …). state/outcome/attrs carry the proposal lifecycle —
-- status⊥state: status is the HTTP outcome, state is where in the
-- lifecycle the entry sits. Most rows write 'resolved' directly;
-- proposing schemes transition 'proposed' → resolved/failed/cancelled.
-- indexed: per-row visibility for OPEN/FOLD via the log:// scheme.
CREATE TABLE IF NOT EXISTS log_entries (
    id              INTEGER NOT NULL PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),

    run_id          INTEGER NOT NULL,
    loop_id         INTEGER NOT NULL,
    turn_id         INTEGER NOT NULL,
    sequence        INTEGER NOT NULL           CHECK (sequence >= 1),
    at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    origin          TEXT    NOT NULL           CHECK (origin IN ('model', 'client', 'system', 'plugin')),
    -- §14.5 environment-delta cause: a sibling run-id or a scheme ('file');
    -- NULL = the owning run itself (self), rendered without a run= label.
    source          TEXT,

    op              TEXT    NOT NULL           CHECK (op IN ('FIND', 'READ', 'EDIT', 'COPY', 'MOVE', 'OPEN', 'FOLD', 'SEND', 'EXEC', 'KILL', 'PLAN')),
    suffix          TEXT    NOT NULL DEFAULT '',
    signal          TEXT                       CHECK (signal IS NULL OR json_valid(signal)),

    scheme          TEXT                       CHECK (scheme IS NULL OR length(scheme) > 0),
    username        TEXT,
    password        TEXT,
    hostname        TEXT,
    port            INTEGER                    CHECK (port IS NULL OR (port BETWEEN 0 AND 65535)),
    pathname        TEXT,
    params          TEXT                       CHECK (params IS NULL OR json_valid(params)),
    fragment        TEXT,

    lineMarker      TEXT                       CHECK (lineMarker IS NULL OR json_valid(lineMarker)),

    tx              TEXT    NOT NULL,
    mimetype_tx     TEXT    NOT NULL           CHECK (length(mimetype_tx) > 0),

    rx              TEXT    NOT NULL,
    mimetype_rx     TEXT    NOT NULL           CHECK (length(mimetype_rx) > 0),
    status_rx       INTEGER NOT NULL           CHECK (status_rx BETWEEN 100 AND 599),

    tokens          INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),

    state           TEXT    NOT NULL DEFAULT 'resolved'
                    CHECK (state IN ('proposed', 'resolved', 'failed', 'cancelled')),
    outcome         TEXT,
    attrs           TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),

    indexed         INTEGER NOT NULL DEFAULT 1 CHECK (indexed IN (0, 1)),

    FOREIGN KEY (run_id)  REFERENCES runs(id)  ON DELETE CASCADE,
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS log_entries_turn_id_sequence ON log_entries (turn_id, sequence);
CREATE        INDEX IF NOT EXISTS log_entries_run_id           ON log_entries (run_id);
CREATE        INDEX IF NOT EXISTS log_entries_loop_id          ON log_entries (loop_id);
CREATE        INDEX IF NOT EXISTS log_entries_at               ON log_entries (at);

-- Column-scoped immutability: the original action's identity and target
-- never change; the proposal lifecycle is allowed to mutate state,
-- outcome, status_rx, rx, indexed.
CREATE TRIGGER IF NOT EXISTS log_entries_immutable_core
BEFORE UPDATE OF
    run_id, loop_id, turn_id, sequence, at, origin, source,
    op, suffix, signal,
    scheme, username, password, hostname,
    port, pathname, params, fragment,
    lineMarker, tx, mimetype_tx, mimetype_rx, attrs
ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only state/outcome/status_rx/rx/indexed may change');
END;

-- INIT: schemes_providers
-- Scheme/provider catalog. Schemes are static (registered at boot);
-- providers carry per-model metadata for cost accounting and selection.
CREATE TABLE IF NOT EXISTS schemes (
    name                 TEXT    NOT NULL PRIMARY KEY CHECK (length(name) > 0),
    model_visible        INTEGER NOT NULL             CHECK (model_visible IN (0, 1)),
    category             TEXT    NOT NULL             CHECK (length(category) > 0),
    default_scope        TEXT    NOT NULL             CHECK (default_scope IN ('agent', 'session')),
    default_channel      TEXT    NOT NULL             CHECK (length(default_channel) > 0),
    channel_orientations TEXT                         CHECK (channel_orientations IS NULL OR json_valid(channel_orientations)),
    writable_by          TEXT    NOT NULL             CHECK (json_valid(writable_by)),
    volatile             INTEGER NOT NULL             CHECK (volatile IN (0, 1)),
    handler              TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS providers (
    id          INTEGER NOT NULL PRIMARY KEY,
    version     INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    provider    TEXT    NOT NULL           CHECK (length(provider) > 0),
    family      TEXT    NOT NULL           CHECK (length(family) > 0),
    model       TEXT    NOT NULL           CHECK (length(model) > 0),
    contextSize INTEGER NOT NULL           CHECK (contextSize >= 1),
    currency    TEXT    NOT NULL           CHECK (length(currency) = 3),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS providers_created_at ON providers (created_at);

-- INIT: cost_rollups
-- Triggers maintaining denormalized cost_pico totals on runs and sessions
-- as turns insert/update. Pure denormalization (textbook trigger use);
-- no branching state-machine logic lives here.
CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_insert_run
AFTER INSERT ON turns
BEGIN
    UPDATE runs
       SET cost_pico = cost_pico + NEW.usage_cost_pico
     WHERE id = (SELECT run_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_insert_session
AFTER INSERT ON turns
BEGIN
    UPDATE sessions
       SET cost_pico = cost_pico + NEW.usage_cost_pico
     WHERE id = (
         SELECT r.session_id
           FROM runs r
           JOIN loops l ON l.run_id = r.id
          WHERE l.id = NEW.loop_id
     );
END;

CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_update_run
AFTER UPDATE OF usage_cost_pico ON turns
WHEN NEW.usage_cost_pico != OLD.usage_cost_pico
BEGIN
    UPDATE runs
       SET cost_pico = cost_pico + NEW.usage_cost_pico - OLD.usage_cost_pico
     WHERE id = (SELECT run_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_update_session
AFTER UPDATE OF usage_cost_pico ON turns
WHEN NEW.usage_cost_pico != OLD.usage_cost_pico
BEGIN
    UPDATE sessions
       SET cost_pico = cost_pico + NEW.usage_cost_pico - OLD.usage_cost_pico
     WHERE id = (
         SELECT r.session_id
           FROM runs r
           JOIN loops l ON l.run_id = r.id
          WHERE l.id = NEW.loop_id
     );
END;

-- INIT: subscriptions
-- Subscription registry per SPEC §7.1. Exists ONLY for cancellation
-- routing (SEND[499] → lookup → scheme teardown). Closed rows persist
-- for forensics; partial unique index enforces one active subscription
-- per (run, entry).
CREATE TABLE IF NOT EXISTS subscriptions (
    id           INTEGER NOT NULL PRIMARY KEY,
    version      INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    run_id       INTEGER NOT NULL,
    entry_id     INTEGER NOT NULL,
    scheme       TEXT    NOT NULL CHECK (length(scheme) > 0),
    handle       TEXT    NOT NULL CHECK (length(handle) > 0),
    opened_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    closed_at    TEXT,
    close_status INTEGER          CHECK (close_status IS NULL OR (close_status BETWEEN 100 AND 599)),
    CHECK ((closed_at IS NULL AND close_status IS NULL)
        OR (closed_at IS NOT NULL AND close_status IS NOT NULL)),
    FOREIGN KEY (run_id)   REFERENCES runs(id)    ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_one_per_entry
    ON subscriptions (run_id, entry_id)
    WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS subscriptions_scheme_active
    ON subscriptions (scheme)
    WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS subscriptions_opened_at ON subscriptions (opened_at);

-- INIT: run_watermarks
-- §14.5 environment-delta detection. Per (run, entry, channel): the content this
-- run last reconciled. First sight sets it silently (no delta); a later content
-- change materializes a delta-EDIT (the diff span, §14.6) and advances the mark.
-- plurnk:// derived entries (manifest/prompt) are excluded at the query, not here.
CREATE TABLE IF NOT EXISTS run_watermarks (
    run_id   INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    channel  TEXT    NOT NULL,
    content  TEXT    NOT NULL,
    PRIMARY KEY (run_id, entry_id, channel),
    FOREIGN KEY (run_id)   REFERENCES runs(id)    ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- INIT: session_constraints
-- SPEC §14.3 constraint overlay — the client's supersede over git membership.
-- Per (session, effect, glob): `add` (members git misses, resolved by a targeted
-- client-dictated scan), `ignore` (drop git-tracked matches), `read-only` (member
-- for read; File.edit rejects the write). git-absent, `add` rows are the sole
-- membership source. Composed at membership resolution; node:path.matchesGlob.
CREATE TABLE IF NOT EXISTS session_constraints (
    session_id INTEGER NOT NULL,
    effect     TEXT    NOT NULL CHECK (effect IN ('add', 'ignore', 'read-only')),
    glob       TEXT    NOT NULL,
    PRIMARY KEY (session_id, effect, glob),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
