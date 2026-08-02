-- MIGRATE: 1 baseline
-- The complete v3 schema baseline. SqlRite owns PRAGMA user_version: subsequent
-- MIGRATE blocks are both the evolution history and the external schema stamp.

-- workspaces
-- project_root: workspace pointer. NULL = headless (no disk side-effects);
-- non-null = absolute path to the client's source tree, supplied at
-- workspace.create or workspace.set_root.
CREATE TABLE IF NOT EXISTS workspaces (
    id                        INTEGER NOT NULL PRIMARY KEY,
    version                   INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    name                      TEXT    NOT NULL UNIQUE CHECK (length(name) > 0),
    created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cost_pico                 INTEGER NOT NULL DEFAULT 0 CHECK (cost_pico >= 0),
    scheme_registry_additions TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(scheme_registry_additions)),
    project_root              TEXT,
    -- #231 client-chosen workspace-open context: { manifestItems?, mdDocs? }, read at turn-0
    -- with precedence over env (manifestItems replaces PLURNK_MANIFEST_ITEMS; mdDocs unions PLURNK_MD_*).
    settings                  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(settings))
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_created_at ON workspaces (created_at);

-- runs
CREATE TABLE IF NOT EXISTS workers (
    id            INTEGER NOT NULL PRIMARY KEY,
    version       INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    workspace_id    INTEGER NOT NULL,
    name          TEXT    NOT NULL CHECK (length(name) > 0),
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- runs fork via parent_worker_id; workspaces carry no parent — {§machine-processes-no-fork-workspace}
    parent_worker_id INTEGER          CHECK (parent_worker_id IS NULL OR parent_worker_id != id),
    cost_pico     INTEGER NOT NULL DEFAULT 0 CHECK (cost_pico >= 0),
    origin        TEXT    NOT NULL DEFAULT 'client' CHECK (origin IN ('model', 'client', 'plurnk')),
    FOREIGN KEY (workspace_id)    REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_worker_id) REFERENCES workers(id)     ON DELETE CASCADE
) STRICT;

CREATE        INDEX IF NOT EXISTS workers_workspace_id_created_at ON workers (workspace_id, created_at);
CREATE        INDEX IF NOT EXISTS workers_parent_worker_id         ON workers (parent_worker_id);
-- NOT unique: a name is frozen per worker ({§machine-processes-worker-origin}) but RECLAIMABLE across
-- time — a terminated run keeps its name in permanent history while a fresh spawn reuses it;
-- worker_resolve_by_name picks the newest. A LIVE collision is refused at the spawn gate (Run.edit
-- → worker_live_by_name → 409), never by this index. Indexed for the by-name resolve/spawn lookup.
CREATE        INDEX IF NOT EXISTS workers_workspace_name          ON workers (workspace_id, name);

-- loops
-- flags: per-loop runtime flags (auto, noProposals, noWeb, noInteraction,
-- mode). JSON column, merged over DEFAULT_LOOP_FLAGS in code so missing
-- keys read as their defaults. SchemeRegistry.resolveForLoop gates schemes
-- by manifest affinity (proposes / excludedInAsk / requiresWeb / etc).
CREATE TABLE IF NOT EXISTS loops (
    id       INTEGER NOT NULL PRIMARY KEY,
    version  INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    worker_id   INTEGER NOT NULL,
    sequence INTEGER NOT NULL             CHECK (sequence >= 1),
    status   INTEGER NOT NULL DEFAULT 102 CHECK (status IN (100, 102, 200, 202, 413, 429, 499, 500, 504, 508)),
    prompt   TEXT    NOT NULL,
    flags    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(flags)),
    -- #249 — attribution tags of the loop's active plugins (string[] JSON); the activity tagged
    -- with what its plugins offer. Same set the engine rides on each turn's generate() wire.
    attributions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attributions)),
    -- #260 — client-passed @file paths foisted as turn-0 READs (string[] JSON). The daemon owns the
    -- workspace, so it READs them in instead of the client inlining bytes (co-location law).
    open_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_paths)),
    -- {§worker-scheme} loop-termination delta: terminated_at is stamped by the trigger
    -- below when status crosses into terminal (every death-path, uniformly);
    -- terminal_message is the deliverable — the SEND[200] body or the abandonment
    -- reason — set by the guarded terminal lifecycle transition.
    terminated_at    TEXT,
    terminal_message TEXT,
    -- Who ended the loop when it wasn't the model's own deliberate terminal: 'collapse' (the
    -- ∅-wait conclude, #379) or 'cancel' (an external loop.cancel, #380). NULL = the model's own
    -- SEND / the engine's budget-strike terminals, whose status already carries the story. The
    -- COLLECT and the termination delta render it as a marker ALONGSIDE terminal_message — the
    -- model's words are never rewritten; the engine's act is named.
    terminated_by    TEXT                      CHECK (terminated_by IS NULL OR terminated_by IN ('collapse', 'cancel')),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS loops_worker_id_sequence ON loops (worker_id, sequence);

-- {§worker-scheme}: a loop crossing into a terminal status stamps terminated_at, so sibling
-- runs pull the termination as a folded ambient delta — caught uniformly across every
-- death-path (SEND, grinder, max-turns, strike, KILL). The stamp updates terminated_at,
-- never status, so it cannot re-fire this trigger. Terminals: 200 done · 413 budget ·
-- 429 turn-ceiling · 499 cancel · 500 fail · 504 wall-clock timeout · 508 runaway. (202 = parked/sleeping, NOT terminal.)
CREATE TRIGGER IF NOT EXISTS loops_stamp_terminated_at
AFTER UPDATE OF status ON loops
WHEN NEW.status IN (200, 413, 429, 499, 500, 504, 508) AND OLD.status NOT IN (200, 413, 429, 499, 500, 504, 508)
BEGIN
    UPDATE loops SET terminated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- turns
-- finish_reason / model: provider-call metadata from the provider response contract.
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
    usage_reasoning  INTEGER NOT NULL DEFAULT 0 CHECK (usage_reasoning >= 0),
    usage_cached     INTEGER NOT NULL DEFAULT 0 CHECK (usage_cached >= 0),
    usage_cost_pico  INTEGER NOT NULL DEFAULT 0 CHECK (usage_cost_pico >= 0),
    -- #274 — the context window of the model that RAN this turn (provider.contextSize), so the
    -- gauge denominator matches the loop's actual model under any /model switch. NULL = the
    -- provider can't report a window (the client omits the gauge).
    usage_prompt_budget INTEGER                  CHECK (usage_prompt_budget IS NULL OR usage_prompt_budget >= 1),
    packet           TEXT    NOT NULL           CHECK (json_valid(packet)),
    finish_reason    TEXT,
    model            TEXT    NOT NULL DEFAULT 'unknown' CHECK (length(model) >= 1),
    -- #252 — opaque provider→client metadata passthrough (e.g. balancePico). Stored
    -- UNENFORCED (json_valid only, no schema): the canonical-field contract lives between
    -- the provider framework (normalizes) and the client (renders) — the service authors
    -- only the engine-stamped rail keys ({§rail-truth-engine-verdict}, #534).
    meta             TEXT    NOT NULL DEFAULT '{}'     CHECK (json_valid(meta)),
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS turns_loop_id_sequence ON turns (loop_id, sequence);
CREATE        INDEX IF NOT EXISTS turns_timestamp        ON turns (timestamp);

-- derivations
-- Content-addressed deep projections. Entries point at a COMPLETE artifact by
-- deep_hash; graph, FTS, and vectors are stored once regardless of how many
-- workspace/worktree paths carry identical content under the same reader/config.
-- A building row is unattached and safely replaceable after interruption.
CREATE TABLE IF NOT EXISTS derivations (
    id          INTEGER NOT NULL PRIMARY KEY,
    deep_hash   TEXT    NOT NULL UNIQUE CHECK (length(deep_hash) > 0),
    state       TEXT    NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'complete')),
    disposition TEXT    CHECK (disposition IN ('vector', 'lexical', 'excluded', 'nonsemantic', 'failed')),
    reason      TEXT,
    CHECK ((state = 'building' AND disposition IS NULL) OR (state = 'complete' AND disposition IS NOT NULL))
) STRICT;

-- entries
-- The canonical addressable store. (workspace, owner, scheme, pathname) is the identity
-- tuple, and NO component may be NULL: NULLs are distinct under SQL UNIQUE, so a nullable
-- component voids the identity index — the #526 disease, re-run on this axis as run59/#545
-- (one phantom member row per turn; 74k rows for 530 identities). Bare/file paths persist
-- under the reserved 'file' scheme; they still RENDER as bare paths. {§entry-identity-no-null}
CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER NOT NULL PRIMARY KEY,
    version    INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    workspace_id INTEGER,
    scheme     TEXT    NOT NULL             CHECK (length(scheme) > 0),
    username   TEXT,
    password   TEXT,
    hostname   TEXT,
    port       INTEGER                      CHECK (port IS NULL OR (port BETWEEN 0 AND 65535)),
    pathname   TEXT    NOT NULL,
    -- #527 {§entry-owner} — every entry is owned by a worker: the spawning worker for capability
    -- streams, the workspace's reserved 'commons' worker for shared content. A real row, never
    -- NULL (NULLs are distinct under UNIQUE — a nullable owner would let the commons fragment).
    -- The id never renders into a URI or packet; the model addresses owners by NAME (authority).
    owner_id   INTEGER NOT NULL,
    params     TEXT                         CHECK (params IS NULL OR json_valid(params)),
    attributes TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
    -- SPEC {§membership} — how a file member entered the curated surface. 'git' rows are
    -- reconciled against the repo's members each turn — tracked ls-files PLUS untracked-
    -- but-not-ignored files ({§membership-auto-add}) — registered + un-registered so entries
    -- == members; 'client'/'constraint' (model-created, add-glob) are not git's to reclaim.
    -- NULL = not a file member (other schemes don't carry origin).
    membership_origin TEXT                   CHECK (membership_origin IS NULL OR membership_origin IN ('git', 'client', 'constraint')),
    -- @graph / ~semantic change-gate (#186): hash of the body content at the last
    -- deep-channel derivation. The manifest-add pass re-derives symbols/refs (and
    -- embeddings, later) ONLY when this differs from the current body hash — an
    -- unchanged entry is skipped, never re-metadatafied every turn.
    deep_hash TEXT,
    -- SPEC {§membership-change-gated-sync} — the per-member sync stat-detect:
    -- "<mtimeMs>:<size>" of the disk file at its last materialization. The pre-turn
    -- sync stat()s every member but re-reads/re-tokenizes/rewrites only one whose
    -- signature changed; an unchanged member is a no-op. NULL = never synced.
    synced_sig TEXT,
    -- User Note 5 — manifest cache-friendliness. Last-modified stamp, bumped on every
    -- channel write by entries_touch_on_channel_write; engine_list_workspace_entries orders
    -- the catalog by it ASC so dormant entries hold the stable prompt-cache prefix.
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (workspace_id IS NOT NULL),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id)     REFERENCES workers(id)    ON DELETE CASCADE,
    FOREIGN KEY (deep_hash)    REFERENCES derivations(deep_hash)
) STRICT;

-- {§entry-owner} / {§stream-owner-scoped} — ONE identity: the owner is the axis (scope is dead).
-- Concurrent workers' capability streams share the loop-relative coordinate (every worker's first
-- loop is seq 1), so identity keys on the owner and identical coordinates are DISTINCT rows (#526).
CREATE UNIQUE INDEX IF NOT EXISTS entries_identity ON entries (workspace_id, owner_id, scheme, pathname);

-- entries_scheme_heal
-- v1→v2 in-place heal ({§entry-identity-no-null}): fold legacy NULL-scheme member rows onto
-- the reserved 'file' scheme. Idempotent — a second pass updates zero rows. A v1 db already
-- fragmented by the #545 duplicate class fails HERE on the identity index, loudly and by
-- design: a fragmented store has no safe automatic merge; recover via a fresh db.
UPDATE entries SET scheme = 'file' WHERE scheme IS NULL;

-- entries_pathname_heal
-- v2→v3 in-place heal ({§fs-canonical-name}): file-class keys migrate to the bare git-pathspec
-- form — the leading slash was the retired namespace-origin notation. Idempotent; a db holding
-- both spellings of one member fails HERE on the identity index, loudly (fresh-db recovery).
UPDATE entries SET pathname = substr(pathname, 2) WHERE scheme = 'file' AND pathname LIKE '/%';

-- The ONE engine-imposed constraint (SPEC {§stream-constraints}, {§stream-constraints-engine-one-cap}): 100 MiB char-length cap
-- per channel content body. All other limits are extrinsic.
CREATE TABLE IF NOT EXISTS entry_channels (
    entry_id INTEGER NOT NULL,
    name     TEXT    NOT NULL             CHECK (length(name) > 0),
    content  TEXT    NOT NULL             CHECK (length(content) <= 104857600),
    mimetype TEXT    NOT NULL             CHECK (length(mimetype) > 0),
    tokens   INTEGER NOT NULL DEFAULT 0   CHECK (tokens >= 0),
    -- content identity: sha256 of content, stamped at static writes (streamed appends leave it
    -- NULL). The per-tokenizer token cache it once keyed was retired — {§tokenomics-agnostic-ruler}.
    content_hash TEXT,
    state    TEXT    NOT NULL DEFAULT 'static' CHECK (state IN ('static', 'active', 'closed', 'errored')),
    PRIMARY KEY (entry_id, name),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- User Note 5 — bump the entry's updated_at on any channel write so the catalog
-- (ordered by updated_at ASC) keeps recently-touched entries at the tail and holds
-- the prompt-cache prefix stable across turns.
CREATE TRIGGER IF NOT EXISTS entries_touch_on_channel_write
AFTER INSERT ON entry_channels
BEGIN
    UPDATE entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.entry_id;
END;

CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id INTEGER NOT NULL,
    tag      TEXT    NOT NULL CHECK (length(tag) > 0),
    PRIMARY KEY (entry_id, tag),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS entry_tags_tag ON entry_tags (tag);

-- symbol_defs
-- @graph NODES (plurnk-service#186). Code symbol definitions, populated
-- once per content-addressed derivation from mimetypes'
-- `symbols` channel. Qualified path = container ? container || '.' || name : name.
CREATE TABLE IF NOT EXISTS symbol_defs (
    id         INTEGER NOT NULL PRIMARY KEY,
    derivation_id INTEGER NOT NULL,
    name       TEXT    NOT NULL CHECK (length(name) > 0),
    kind       TEXT    NOT NULL,
    container  TEXT,
    line       INTEGER NOT NULL,
    end_line   INTEGER,
    FOREIGN KEY (derivation_id) REFERENCES derivations(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS symbol_defs_name ON symbol_defs (name);

-- symbol_refs
-- @graph EDGES (plurnk-service#186), from mimetypes' `references` channel.
-- name = edge TARGET; container = the SOURCE def's full qualified path (the
-- @> join key; module-level → NULL); kind ∈ import|call|instantiate|inherit|
-- type|use (frozen, edge metadata only — traversal is kind-agnostic).
CREATE TABLE IF NOT EXISTS symbol_refs (
    id         INTEGER NOT NULL PRIMARY KEY,
    derivation_id INTEGER NOT NULL,
    name       TEXT    NOT NULL CHECK (length(name) > 0),
    kind       TEXT    NOT NULL,
    container  TEXT,
    line       INTEGER NOT NULL,
    col        INTEGER,
    FOREIGN KEY (derivation_id) REFERENCES derivations(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS symbol_refs_name   ON symbol_refs (name);
CREATE INDEX IF NOT EXISTS symbol_refs_source ON symbol_refs (derivation_id, container);

-- entry_fts (~semantic FTS half — plurnk-service#186)
-- Keyword/content index over a derivation's readable content; rowid IS derivations.id.
-- Explicit keyword fallback when no embedder is installed. Vector search never
-- consults this table: semantic recall is exhaustive over complete vectors.
CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(content);

-- entry_embeddings (~semantic vector half — plurnk-service#186; Project
-- Semantics chunking). One Float32 vector per CHUNK: a derivation tiles into N chunks,
-- each addressed by its <L> line range (line_start..line_end) and embedded
-- separately, so a large body is fully searchable instead of truncated at the
-- embedder's window. line_start/line_end are stored for Project Findings to expose;
-- the rank currently max-pools a derivation's chunks, then projects every attached
-- pathname. semantic_rank exhaustively cosine-ranks these.
-- CASCADE-deleted with the derivation artifact.
CREATE TABLE IF NOT EXISTS entry_embeddings (
    derivation_id   INTEGER NOT NULL,
    chunk_seq       INTEGER NOT NULL,
    line_start      INTEGER NOT NULL,
    line_end        INTEGER NOT NULL,
    vector          BLOB    NOT NULL,
    -- The model id that produced this vector (mimetypes' `embeddingModel`). Stored
    -- per row as the dimension/staleness guard: rank filters by the current model so
    -- a swap never cosine-compares mismatched dimensions.
    embedding_model TEXT    NOT NULL,
    PRIMARY KEY (derivation_id, chunk_seq),
    FOREIGN KEY (derivation_id) REFERENCES derivations(id) ON DELETE CASCADE
) STRICT;

-- log_entries
-- Chronological event store. sequence is 1-based, scoped to the turn —
-- resets at each new turn. URI-bit columns are unprefixed (scheme,
-- pathname, …). state/outcome/attrs carry the proposal lifecycle —
-- status⊥state: status is the HTTP outcome, state is where in the
-- lifecycle the entry sits. Most rows write 'resolved' directly;
-- proposing schemes transition 'proposed' → resolved/failed/cancelled.
-- expanded: per-row visibility for OPEN/FOLD via the log:/// scheme.
CREATE TABLE IF NOT EXISTS log_entries (
    id              INTEGER NOT NULL PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),

    worker_id          INTEGER NOT NULL,
    loop_id         INTEGER NOT NULL,
    turn_id         INTEGER NOT NULL,
    sequence        INTEGER NOT NULL           CHECK (sequence >= 1),
    at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    origin          TEXT    NOT NULL           CHECK (origin IN ('model', 'client', 'plurnk', 'plugin')),
    -- {§env-delta} environment-delta cause: a sibling run-id or a scheme ('file');
    -- NULL = the owning run itself (self), rendered without a worker= label.
    source          TEXT,

    -- 'error' is an ACTIONLESS row ({§operation-results} — errors are log items): a parse failure that
    -- produced no op still records a log entry (op='error', status_rx≥400, no target) so the model
    -- can fold/kill/recall its own mistakes like any other log row — one budget surface, the log.
    -- 'model' is an ACTIONLESS row too ({§model-entry}): the model's own verbatim emission, mirrored
    -- back as a foldable log item so it can finally SEE its prior output (born folded; the turn-0
    -- exemplar is born open). text/vnd.plurnk-typed; OPEN/FOLD/KILL-able like any row.
    -- No op enum here: the grammar op set is grammar's contract (PlurnkOp), and this column is written
    -- only by the PlurnkOp-typed engine (grammar ops) or with the two service markers ('error','model').
    -- A SQL enum would be a hand-copy of grammar's op list that silently goes stale on every new verb
    -- (it did — FORK/WORK). Validity lives at the parse + type layer, not duplicated in DDL.
    op              TEXT    NOT NULL,
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

    expanded         INTEGER NOT NULL DEFAULT 1 CHECK (expanded IN (0, 1)),

    FOREIGN KEY (worker_id)  REFERENCES workers(id)  ON DELETE CASCADE,
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS log_entries_turn_id_sequence ON log_entries (turn_id, sequence);
CREATE        INDEX IF NOT EXISTS log_entries_worker_id           ON log_entries (worker_id);
CREATE        INDEX IF NOT EXISTS log_entries_loop_id          ON log_entries (loop_id);
CREATE        INDEX IF NOT EXISTS log_entries_at               ON log_entries (at);

-- {§log-region-tagging} — named log-region curation. FOLD is the log's write-op (EDIT can't
-- reach engine-written rows): FOLD[tag] stamps a tag on a region; OPEN[tag]/FIND[tag] filter
-- by it. Mirrors entry_tags (apply additive / filter ALL-tags AND); CASCADE with the row on KILL.
CREATE TABLE IF NOT EXISTS log_tags (
    log_entry_id INTEGER NOT NULL,
    tag          TEXT    NOT NULL CHECK (length(tag) > 0),
    PRIMARY KEY (log_entry_id, tag),
    FOREIGN KEY (log_entry_id) REFERENCES log_entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS log_tags_tag ON log_tags (tag);

-- Column-scoped immutability: the original action's identity and target
-- never change; the proposal lifecycle is allowed to mutate state,
-- outcome, status_rx, rx, expanded.
CREATE TRIGGER IF NOT EXISTS log_entries_immutable_core
BEFORE UPDATE OF
    worker_id, loop_id, turn_id, sequence, at, origin, source,
    op, suffix, signal,
    scheme, username, password, hostname,
    port, pathname, params, fragment,
    lineMarker, tx, mimetype_tx, mimetype_rx, attrs
ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only state/outcome/status_rx/rx/expanded may change');
END;

-- schemes_providers
-- Scheme/provider catalog. Schemes are static (registered at boot);
-- providers carry per-model metadata for cost accounting and selection.
CREATE TABLE IF NOT EXISTS schemes (
    name                 TEXT    NOT NULL PRIMARY KEY CHECK (length(name) > 0),
    model_visible        INTEGER NOT NULL             CHECK (model_visible IN (0, 1)),
    category             TEXT    NOT NULL             CHECK (length(category) > 0),
    default_scope        TEXT    NOT NULL             CHECK (default_scope IN ('workspace')),
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

-- cost_rollups
-- Triggers maintaining denormalized cost_pico totals on runs and workspaces
-- as turns insert/update. Pure denormalization (textbook trigger use);
-- no branching state-machine logic lives here.
CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_insert_worker
AFTER INSERT ON turns
BEGIN
    UPDATE workers
       SET cost_pico = cost_pico + NEW.usage_cost_pico
     WHERE id = (SELECT worker_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_insert_workspace
AFTER INSERT ON turns
BEGIN
    UPDATE workspaces
       SET cost_pico = cost_pico + NEW.usage_cost_pico
     WHERE id = (
         SELECT r.workspace_id
           FROM workers r
           JOIN loops l ON l.worker_id = r.id
          WHERE l.id = NEW.loop_id
     );
END;

CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_update_worker
AFTER UPDATE OF usage_cost_pico ON turns
WHEN NEW.usage_cost_pico != OLD.usage_cost_pico
BEGIN
    UPDATE workers
       SET cost_pico = cost_pico + NEW.usage_cost_pico - OLD.usage_cost_pico
     WHERE id = (SELECT worker_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_update_workspace
AFTER UPDATE OF usage_cost_pico ON turns
WHEN NEW.usage_cost_pico != OLD.usage_cost_pico
BEGIN
    UPDATE workspaces
       SET cost_pico = cost_pico + NEW.usage_cost_pico - OLD.usage_cost_pico
     WHERE id = (
         SELECT r.workspace_id
           FROM workers r
           JOIN loops l ON l.worker_id = r.id
          WHERE l.id = NEW.loop_id
     );
END;

-- subscriptions
-- Durable subscription lifecycle per SPEC {§subscriptions}. The row records what
-- the worker holds and routes cancellation to a separate process-local callable;
-- it never serializes that callable. Closed rows persist for forensics; partial
-- unique index enforces one active subscription per (worker, entry).
CREATE TABLE IF NOT EXISTS subscriptions (
    id           INTEGER NOT NULL PRIMARY KEY,
    version      INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    worker_id       INTEGER NOT NULL,
    entry_id     INTEGER NOT NULL,
    scheme       TEXT    NOT NULL CHECK (length(scheme) > 0),
    handle       TEXT    NOT NULL CHECK (length(handle) > 0),
    opened_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- grammar 0.74.20 EXEC `<T,P>` poll cadence (seconds). NULL = not polled. While the owning
    -- loop hibernates (202), the daemon wakes it every poll_seconds to inspect this stream ({§exec-poll}).
    poll_seconds INTEGER          CHECK (poll_seconds IS NULL OR poll_seconds > 0),
    -- EXEC `<0>` — turn-scoped: the stream is reaped at the worker's next pre-turn so it never survives
    -- into the subsequent turn; its terminal output surfaces born-OPEN like any conclusion. {§exec-poll}
    turn_scoped  INTEGER NOT NULL DEFAULT 0 CHECK (turn_scoped IN (0, 1)),
    closed_at    TEXT,
    close_status INTEGER          CHECK (close_status IS NULL OR (close_status BETWEEN 100 AND 599)),
    CHECK ((closed_at IS NULL AND close_status IS NULL)
        OR (closed_at IS NOT NULL AND close_status IS NOT NULL)),
    FOREIGN KEY (worker_id)   REFERENCES workers(id)    ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_one_per_entry
    ON subscriptions (worker_id, entry_id)
    WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS subscriptions_scheme_active
    ON subscriptions (scheme)
    WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS subscriptions_opened_at ON subscriptions (opened_at);

-- (worker_watermarks removed — {§env-delta} is now pull-from-log, no per-worker snapshot.)

-- workspace_constraints
-- SPEC {§membership} constraint overlay — the client's supersede over git membership.
-- Per (workspace, effect, glob/target): `pick` (members git misses, resolved by a
-- targeted client-dictated scan), `hide` (drop git-tracked matches), `view` (member
-- for read; File.edit rejects the write). git-absent, `pick` rows are the sole substrate
-- source. Composed at membership resolution; node:path.matchesGlob.
CREATE TABLE IF NOT EXISTS workspace_constraints (
    workspace_id INTEGER NOT NULL,
    effect     TEXT    NOT NULL CHECK (effect IN ('pick', 'hide', 'view')),
    glob       TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, effect, glob),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
