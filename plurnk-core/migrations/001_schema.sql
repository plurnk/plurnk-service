-- MIGRATE: 1 baseline
-- The single current pre-release schema baseline. Shape changes replace it;
-- existing development databases are deleted and recreated, never upgraded.

-- workspaces
-- project_root: workspace pointer. NULL = headless (no disk side-effects);
-- non-null = absolute path to the client's source tree, supplied at
-- workspace.create or workspace.set_root.
CREATE TABLE IF NOT EXISTS workspaces (
    id                        INTEGER NOT NULL PRIMARY KEY,
    version                   INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    name                      TEXT    NOT NULL UNIQUE CHECK (length(name) > 0),
    created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cost_usd                  REAL    NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
    project_root              TEXT,
    -- {§operator-config} validated client workspace settings; each field composes
    -- with operator configuration at its owning use site.
    settings                  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(settings))
) STRICT;

CREATE INDEX IF NOT EXISTS workspaces_created_at ON workspaces (created_at);

-- workers
CREATE TABLE IF NOT EXISTS workers (
    id              INTEGER NOT NULL PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    workspace_id    INTEGER NOT NULL,
    name            TEXT    NOT NULL CHECK (length(name) > 0),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- workers fork via parent_worker_id; workspaces carry no parent — {§machine-processes-no-fork-workspace}
    parent_worker_id INTEGER          CHECK (parent_worker_id IS NULL OR parent_worker_id != id),
    cost_usd        REAL    NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
    origin          TEXT    NOT NULL DEFAULT 'client' CHECK (origin IN ('model', 'client', 'plurnk')),
    -- {§env-delta-log-pull}: monotonic observation progress, not a private world snapshot.
    -- NULL means the worker has not established its first-turn baseline yet.
    ambient_event_cursor INTEGER      CHECK (ambient_event_cursor IS NULL OR ambient_event_cursor >= 0),
    FOREIGN KEY (workspace_id)    REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_worker_id) REFERENCES workers(id)     ON DELETE CASCADE
) STRICT;

CREATE        INDEX IF NOT EXISTS workers_workspace_id_created_at ON workers (workspace_id, created_at);
CREATE        INDEX IF NOT EXISTS workers_parent_worker_id         ON workers (parent_worker_id);
-- NOT unique: a name is frozen per worker ({§machine-processes-worker-origin}) but RECLAIMABLE across
-- time — a terminated worker keeps its name in permanent history while a fresh spawn reuses it;
-- worker_resolve_by_name picks the newest. A LIVE collision is refused at the spawn gate (Worker.edit
-- → worker_live_by_name → 409), never by this index. Indexed for the by-name resolve/spawn lookup.
CREATE        INDEX IF NOT EXISTS workers_workspace_name          ON workers (workspace_id, name);

-- {§env-delta-log-pull}: one append-only occurrence journal gives every ambient
-- producer a shared monotonic order. It snapshots only what the observer row
-- needs; shared-world contents remain owned by entries/files, never copied here.
-- source_record_id is forensic identity for the originating log/loop row, not a
-- foreign key: model log curation must not erase an already-recorded occurrence.
CREATE TABLE IF NOT EXISTS ambient_events (
    id                 INTEGER NOT NULL PRIMARY KEY,
    workspace_id       INTEGER NOT NULL,
    producer_worker_id INTEGER NOT NULL,
    kind               TEXT    NOT NULL CHECK (kind IN ('edit', 'loop_termination')),
    source_record_id   INTEGER NOT NULL CHECK (source_record_id >= 1),
    source             TEXT,
    op                 TEXT    NOT NULL CHECK (op IN ('EDIT', 'SEND')),
    scheme             TEXT,
    hostname           TEXT,
    pathname           TEXT,
    rx                 TEXT,
    attrs              TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
    status_rx          INTEGER NOT NULL CHECK (status_rx BETWEEN 100 AND 599),
    prompt             TEXT,
    terminated_by      TEXT             CHECK (terminated_by IS NULL OR terminated_by = 'cancel'),
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
        (kind = 'edit' AND op = 'EDIT' AND rx IS NOT NULL AND prompt IS NULL AND terminated_by IS NULL)
        OR
        (kind = 'loop_termination' AND op = 'SEND' AND scheme = 'worker' AND prompt IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id)       REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (producer_worker_id) REFERENCES workers(id)    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS ambient_events_workspace_id_id
    ON ambient_events (workspace_id, id);
CREATE INDEX IF NOT EXISTS ambient_events_producer_kind_id
    ON ambient_events (producer_worker_id, kind, id);

-- loops
-- flags: per-loop runtime flags (auto, noProposals, noWeb, noInteraction,
-- mode). JSON column, merged over DEFAULT_LOOP_FLAGS in code so missing
-- keys read as their defaults. SchemeRegistry.resolveForLoop gates schemes
-- by manifest affinity (excludedInAsk / requiresWeb / requiresInteraction).
CREATE TABLE IF NOT EXISTS loops (
    id       INTEGER NOT NULL PRIMARY KEY,
    version  INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    worker_id   INTEGER NOT NULL,
    sequence INTEGER NOT NULL             CHECK (sequence >= 1),
    status   INTEGER NOT NULL DEFAULT 102 CHECK (status IN (100, 102, 200, 202, 413, 429, 499, 500, 504, 508)),
    prompt   TEXT    NOT NULL,
    flags    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(flags)),
    provider_spec TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(provider_spec)),
    max_turns INTEGER NOT NULL DEFAULT 50 CHECK (max_turns >= -1),
    -- {§attribution-discovery-placeholder} — attribution tags of the loop's active plugins (string[] JSON); the activity tagged
    -- with what its plugins offer. Same set the engine rides on each turn's generate() wire.
    attributions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attributions)),
    -- {§methods-loop-run-open-paths}: the initial prompt frame's selected paths,
    -- held here until turn 1 materializes that frame (string[] JSON).
    open_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_paths)),
    -- {§worker-scheme} loop-termination delta: terminated_at is stamped by the trigger
    -- below when status crosses into terminal (every death-path, uniformly);
    -- terminal_message is the deliverable — the SEND[200] body or the abandonment
    -- reason — set by the guarded terminal lifecycle transition.
    terminated_at    TEXT,
    terminal_message TEXT,
    terminal_result  TEXT                      CHECK (terminal_result IS NULL OR json_valid(terminal_result)),
    -- {§loop-terminal-authorship}: 'cancel' names an external loop.cancel;
    -- NULL covers model terminals and engine verdicts whose result carries the story.
    terminated_by    TEXT                      CHECK (terminated_by IS NULL OR terminated_by = 'cancel'),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS loops_worker_id_sequence ON loops (worker_id, sequence);

-- {§worker-scheme}: a loop crossing into a terminal status stamps terminated_at, so sibling
-- workers pull the termination as a folded ambient delta — caught uniformly across every
-- death-path (SEND, grinder, max-turns, strike, KILL). The stamp updates terminated_at,
-- never status, so it cannot re-fire this trigger. Terminals: 200 done · 413 budget ·
-- 429 turn-ceiling · 499 cancel · 500 fail · 504 wall-clock timeout · 508 runaway. (202 = parked/sleeping, NOT terminal.)
CREATE TRIGGER IF NOT EXISTS loops_stamp_terminated_at
AFTER UPDATE OF status ON loops
WHEN NEW.status IN (200, 413, 429, 499, 500, 504, 508) AND OLD.status NOT IN (200, 413, 429, 499, 500, 504, 508)
BEGIN
    UPDATE loops SET terminated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- A terminal transition is an ambient occurrence in the same total order as a
-- shared EDIT. Directly inserted fork history never crosses this transition and
-- therefore cannot fabricate a new conclusion event.
CREATE TRIGGER IF NOT EXISTS loops_append_ambient_event
AFTER UPDATE OF status ON loops
WHEN NEW.status IN (200, 413, 429, 499, 500, 504, 508) AND OLD.status NOT IN (200, 413, 429, 499, 500, 504, 508)
BEGIN
    INSERT INTO ambient_events (
        workspace_id, producer_worker_id, kind, source_record_id, source,
        op, scheme, pathname, rx, status_rx, prompt, terminated_by
    )
    SELECT w.workspace_id, NEW.worker_id, 'loop_termination', NEW.id, NULL,
           'SEND', 'worker', '/' || w.name, NEW.terminal_message, NEW.status, NEW.prompt, NEW.terminated_by
    FROM workers w
    WHERE w.id = NEW.worker_id;
END;

CREATE TRIGGER IF NOT EXISTS loops_result_contract_insert
BEFORE INSERT ON loops
WHEN NEW.status IN (100, 102, 200, 202, 413, 429, 499, 500, 504, 508)
AND NOT (
    (NEW.status IN (100, 102, 202) AND NEW.terminal_result IS NULL)
    OR (
        NEW.status IN (200, 413, 429, 499, 500, 504, 508)
        AND NEW.terminal_result IS NOT NULL
        AND json_valid(NEW.terminal_result)
        AND json_type(NEW.terminal_result, '$.status') = 'integer'
        AND (
            json_extract(NEW.terminal_result, '$.status') = NEW.status
            OR (
                NEW.status = 200
                AND json_extract(NEW.terminal_result, '$.status') BETWEEN 200 AND 399
                AND json_extract(NEW.terminal_result, '$.status') != 202
            )
            OR (
                NEW.status = 500
                AND json_extract(NEW.terminal_result, '$.status') BETWEEN 400 AND 599
            )
        )
        AND (
            (NEW.status < 400 AND json_type(NEW.terminal_result, '$.problem') IS NULL)
            OR (
                NEW.status >= 400
                AND json_type(NEW.terminal_result, '$.problem') = 'object'
                AND json_extract(NEW.terminal_result, '$.problem.status')
                    = json_extract(NEW.terminal_result, '$.status')
                AND length(json_extract(NEW.terminal_result, '$.problem.type')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.title')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.detail')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.instance')) > 0
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'loop terminal result violates the operation-result contract');
END;

CREATE TRIGGER IF NOT EXISTS loops_result_contract_update
BEFORE UPDATE OF status, terminal_result ON loops
WHEN NEW.status IN (100, 102, 200, 202, 413, 429, 499, 500, 504, 508)
AND NOT (
    (NEW.status IN (100, 102, 202) AND NEW.terminal_result IS NULL)
    OR (
        NEW.status IN (200, 413, 429, 499, 500, 504, 508)
        AND NEW.terminal_result IS NOT NULL
        AND json_valid(NEW.terminal_result)
        AND json_type(NEW.terminal_result, '$.status') = 'integer'
        AND (
            json_extract(NEW.terminal_result, '$.status') = NEW.status
            OR (
                NEW.status = 200
                AND json_extract(NEW.terminal_result, '$.status') BETWEEN 200 AND 399
                AND json_extract(NEW.terminal_result, '$.status') != 202
            )
            OR (
                NEW.status = 500
                AND json_extract(NEW.terminal_result, '$.status') BETWEEN 400 AND 599
            )
        )
        AND (
            (NEW.status < 400 AND json_type(NEW.terminal_result, '$.problem') IS NULL)
            OR (
                NEW.status >= 400
                AND json_type(NEW.terminal_result, '$.problem') = 'object'
                AND json_extract(NEW.terminal_result, '$.problem.status')
                    = json_extract(NEW.terminal_result, '$.status')
                AND length(json_extract(NEW.terminal_result, '$.problem.type')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.title')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.detail')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.instance')) > 0
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'loop terminal result violates the operation-result contract');
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
    usage_cost_usd   REAL    NOT NULL DEFAULT 0 CHECK (usage_cost_usd >= 0),
    -- Effective packet allowance for this turn's provider and policy; NULL is
    -- uncapped or unknown. {§tokenomics-client-gauge}
    usage_prompt_budget INTEGER                  CHECK (usage_prompt_budget IS NULL OR usage_prompt_budget >= 1),
    -- {§packet-stored-shape}: NULL means no model request was assembled. A
    -- present packet is either the measured request or that request extended
    -- by the paired admitted-response fields.
    packet           TEXT                       CHECK (
        CASE
            WHEN packet IS NULL THEN 1
            WHEN json_valid(packet) = 0 THEN 0
            ELSE COALESCE(
                json_type(packet) = 'object'
                AND json_type(packet, '$.tokens') = 'integer'
                AND json_extract(packet, '$.tokens') >= 0
                AND json_type(packet, '$.sections') = 'array'
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
    model            TEXT    NOT NULL DEFAULT 'unknown' CHECK (length(model) >= 1),
    -- Opaque provider→client metadata plus engine rail keys; JSON-valid but
    -- otherwise unenforced. {§meta-passthrough}, {§rail-truth-engine-verdict}
    meta             TEXT    NOT NULL DEFAULT '{}'     CHECK (json_valid(meta)),
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS turns_loop_id_sequence ON turns (loop_id, sequence);
CREATE        INDEX IF NOT EXISTS turns_timestamp        ON turns (timestamp);

-- Provider calls are attempts beneath one engine turn. Rejected and interrupted
-- response evidence persists without becoming a turn or entering model-visible
-- history.
CREATE TABLE IF NOT EXISTS turn_attempts (
    id               INTEGER NOT NULL PRIMARY KEY,
    turn_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL CHECK (sequence >= 1),
    accepted         INTEGER NOT NULL CHECK (accepted IN (0, 1)),
    response         TEXT    NOT NULL CHECK (json_valid(response)),
    parse_errors     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(parse_errors)),
    usage_prompt     INTEGER NOT NULL DEFAULT 0 CHECK (usage_prompt >= 0),
    usage_completion INTEGER NOT NULL DEFAULT 0 CHECK (usage_completion >= 0),
    usage_reasoning  INTEGER NOT NULL DEFAULT 0 CHECK (usage_reasoning >= 0),
    usage_cached     INTEGER NOT NULL DEFAULT 0 CHECK (usage_cached >= 0),
    usage_cost_usd   REAL    NOT NULL DEFAULT 0 CHECK (usage_cost_usd >= 0),
    finish_reason    TEXT,
    model            TEXT    NOT NULL CHECK (length(model) >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (turn_id, sequence),
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS turn_attempts_turn_id ON turn_attempts (turn_id);
CREATE UNIQUE INDEX IF NOT EXISTS turn_attempts_one_accepted_per_turn
    ON turn_attempts (turn_id)
    WHERE accepted = 1;

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
-- component voids the identity index. Bare/file paths persist under the reserved `file`
-- scheme; they still render as bare paths. {§entry-identity-no-null}
CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER NOT NULL PRIMARY KEY,
    version    INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    workspace_id INTEGER,
    scheme     TEXT    NOT NULL             CHECK (length(scheme) > 0),
    pathname   TEXT    NOT NULL,
    -- {§entry-owner} — every entry is owned by a worker: the spawning worker for capability
    -- streams, the workspace's reserved 'commons' worker for shared content. A real row, never
    -- NULL (NULLs are distinct under UNIQUE — a nullable owner would let the commons fragment).
    -- The id never renders into a URI or packet; the model addresses owners by NAME (authority).
    owner_id   INTEGER NOT NULL,
    -- Entry-private metadata. Prompt frames use `openPaths` to carry selected
    -- workspace paths into the exact turn that publishes the frame
    -- ({§methods-loop-run-open-paths}).
    attributes TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
    -- SPEC {§membership} — how a file member entered the curated surface. 'git' rows are
    -- reconciled against the repo's members each turn — tracked ls-files PLUS untracked-
    -- but-not-ignored files ({§membership-auto-add}) — registered + un-registered so entries
    -- == members; 'client'/'constraint' (model-created, add-glob) are not git's to reclaim.
    -- NULL = not a file member (other schemes don't carry origin).
    membership_origin TEXT                   CHECK (membership_origin IS NULL OR membership_origin IN ('git', 'client', 'constraint')),
    -- {§membership-change-gated-sync}: hash of the body content at the last
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

-- {§entry-owner} / {§stream-owner-scoped} — owner is the sole visibility and identity axis.
-- Concurrent workers' capability streams share the loop-relative coordinate (every worker's first
-- loop is seq 1), so identity keys on the owner and identical coordinates are distinct rows
-- ({§stream-owner-scoped}).
CREATE UNIQUE INDEX IF NOT EXISTS entries_identity ON entries (workspace_id, owner_id, scheme, pathname);

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
-- @graph NODES ({§relation-indexed-dialects}). Code symbol definitions, populated
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
-- @graph EDGES ({§relation-indexed-dialects}), from mimetypes' `references` channel.
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

-- derivation_fts (~semantic keyword fallback; {§relation-indexed-dialects})
-- Keyword/content index over a derivation's readable content; rowid IS derivations.id.
-- Explicit keyword fallback when no embedder is installed. Vector search never
-- consults this table: semantic recall is exhaustive over complete vectors.
CREATE VIRTUAL TABLE IF NOT EXISTS derivation_fts USING fts5(content);

-- derivation_embeddings (~semantic vectors; {§relation-indexed-dialects}).
-- One canonical wire vector ({§mimetype-embedding-wire}) per CHUNK: a derivation tiles into N chunks,
-- each addressed by its <L> line range (line_start..line_end) and embedded
-- separately, so a large body is fully searchable instead of truncated at the
-- embedder's window. line_start/line_end are stored for Project Findings to expose;
-- the rank currently max-pools a derivation's chunks, then projects every attached
-- pathname. semantic_rank exhaustively cosine-ranks these.
-- CASCADE-deleted with the derivation artifact.
CREATE TABLE IF NOT EXISTS derivation_embeddings (
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
    -- {§env-delta-attribution}: a worker:// name or stable subsystem token ('file');
    -- NULL = the owning worker itself, rendered without causal attribution.
    source          TEXT,
    -- Engine-owned occurrence identity. Source rows are stamped NULL→id by the
    -- journal trigger; observer and fork copies carry it at insertion.
    ambient_event_id INTEGER                  REFERENCES ambient_events(id),
    -- Search derivation attached to this durable log result, when available.
    deep_hash       TEXT                       REFERENCES derivations(deep_hash),

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
    -- Serialized query without '?'; NULL = absent, '' = explicit empty. {§path-query}
    query           TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS log_entries_worker_ambient_event
    ON log_entries (worker_id, ambient_event_id)
    WHERE ambient_event_id IS NOT NULL;

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
    port, pathname, query, fragment,
    lineMarker, tx, mimetype_tx, mimetype_rx, attrs
ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only state/outcome/status_rx/rx/expanded may change');
END;

-- The engine may stamp an originating row exactly once. No later reassignment
-- can sever or counterfeit the occurrence identity.
CREATE TRIGGER IF NOT EXISTS log_entries_ambient_event_once
BEFORE UPDATE OF ambient_event_id ON log_entries
WHEN NOT (OLD.ambient_event_id IS NULL AND NEW.ambient_event_id IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'log_entries ambient event identity may only be assigned once');
END;

-- Immediate successful shared EDITs append their occurrence in the same SQL
-- statement that persists the receipt. Rows already carrying an event id are
-- observer/fork history and can never republish themselves.
CREATE TRIGGER IF NOT EXISTS log_entries_append_ambient_event_insert
AFTER INSERT ON log_entries
WHEN NEW.ambient_event_id IS NULL
 AND NEW.op = 'EDIT'
 AND NEW.state = 'resolved'
 AND NEW.status_rx IN (200, 201)
 AND (NEW.scheme IS NULL OR NEW.scheme != 'plurnk')
 AND (NEW.scheme IS NULL OR NEW.scheme != 'worker' OR NEW.hostname IS NULL OR NEW.hostname = 'plurnk')
 AND (
     NEW.origin != 'plurnk'
     OR EXISTS (SELECT 1 FROM workers w WHERE w.id = NEW.worker_id AND w.name = 'plurnk')
 )
BEGIN
    INSERT INTO ambient_events (
        workspace_id, producer_worker_id, kind, source_record_id, source,
        op, scheme, hostname, pathname, rx, attrs, status_rx
    )
    SELECT w.workspace_id, NEW.worker_id, 'edit', NEW.id, NEW.source,
           'EDIT', NEW.scheme, NEW.hostname, NEW.pathname, NEW.rx, NEW.attrs, NEW.status_rx
    FROM workers w
    WHERE w.id = NEW.worker_id;
    UPDATE log_entries SET ambient_event_id = last_insert_rowid() WHERE id = NEW.id;
END;

-- A proposed EDIT becomes an occurrence only when its one lifecycle transition
-- resolves successfully. Rejection, cancellation, and failed application publish nothing.
CREATE TRIGGER IF NOT EXISTS log_entries_append_ambient_event_resolve
AFTER UPDATE OF state, status_rx ON log_entries
WHEN OLD.state = 'proposed'
 AND NEW.state = 'resolved'
 AND NEW.ambient_event_id IS NULL
 AND NEW.op = 'EDIT'
 AND NEW.status_rx IN (200, 201)
 AND (NEW.scheme IS NULL OR NEW.scheme != 'plurnk')
 AND (NEW.scheme IS NULL OR NEW.scheme != 'worker' OR NEW.hostname IS NULL OR NEW.hostname = 'plurnk')
 AND (
     NEW.origin != 'plurnk'
     OR EXISTS (SELECT 1 FROM workers w WHERE w.id = NEW.worker_id AND w.name = 'plurnk')
 )
BEGIN
    INSERT INTO ambient_events (
        workspace_id, producer_worker_id, kind, source_record_id, source,
        op, scheme, hostname, pathname, rx, attrs, status_rx
    )
    SELECT w.workspace_id, NEW.worker_id, 'edit', NEW.id, NEW.source,
           'EDIT', NEW.scheme, NEW.hostname, NEW.pathname, NEW.rx, NEW.attrs, NEW.status_rx
    FROM workers w
    WHERE w.id = NEW.worker_id;
    UPDATE log_entries SET ambient_event_id = last_insert_rowid() WHERE id = NEW.id;
END;

-- cost_rollups
-- Triggers maintaining denormalized USD totals on workers and workspaces
-- as turns insert/update. Pure denormalization (textbook trigger use);
-- no branching state-machine logic lives here.
CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_insert_worker
AFTER INSERT ON turns
BEGIN
    UPDATE workers
       SET cost_usd = cost_usd + NEW.usage_cost_usd
     WHERE id = (SELECT worker_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_insert_workspace
AFTER INSERT ON turns
BEGIN
    UPDATE workspaces
       SET cost_usd = cost_usd + NEW.usage_cost_usd
     WHERE id = (
         SELECT r.workspace_id
           FROM workers r
           JOIN loops l ON l.worker_id = r.id
          WHERE l.id = NEW.loop_id
     );
END;

CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_update_worker
AFTER UPDATE OF usage_cost_usd ON turns
WHEN NEW.usage_cost_usd != OLD.usage_cost_usd
BEGIN
    UPDATE workers
       SET cost_usd = cost_usd + NEW.usage_cost_usd - OLD.usage_cost_usd
     WHERE id = (SELECT worker_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER IF NOT EXISTS turns_cost_rollup_update_workspace
AFTER UPDATE OF usage_cost_usd ON turns
WHEN NEW.usage_cost_usd != OLD.usage_cost_usd
BEGIN
    UPDATE workspaces
       SET cost_usd = cost_usd + NEW.usage_cost_usd - OLD.usage_cost_usd
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
    published_channel TEXT          CHECK (published_channel IS NULL OR length(published_channel) > 0),
    opened_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- EXEC `<T,P>` poll policy: NULL = default backoff, 0 = disabled, positive = fixed cadence.
    -- While the owning loop hibernates (202), an armed policy wakes it to inspect the stream ({§exec-poll}).
    poll_seconds INTEGER          CHECK (poll_seconds IS NULL OR poll_seconds >= 0),
    -- EXEC `<0>` — turn-scoped: the stream is reaped at the worker's next pre-turn so it never survives
    -- into the subsequent turn; its terminal output surfaces born-OPEN like any conclusion. {§exec-poll}
    turn_scoped  INTEGER NOT NULL DEFAULT 0 CHECK (turn_scoped IN (0, 1)),
    closed_at    TEXT,
    close_status INTEGER          CHECK (close_status IS NULL OR (close_status BETWEEN 100 AND 599)),
    close_result TEXT             CHECK (close_result IS NULL OR json_valid(close_result)),
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

CREATE TRIGGER IF NOT EXISTS subscriptions_result_contract_insert
BEFORE INSERT ON subscriptions
WHEN NOT (
    (NEW.closed_at IS NULL AND NEW.close_status IS NULL AND NEW.close_result IS NULL)
    OR (
        NEW.closed_at IS NOT NULL
        AND NEW.close_status IS NOT NULL
        AND NEW.close_result IS NOT NULL
        AND json_valid(NEW.close_result)
        AND json_type(NEW.close_result, '$.status') = 'integer'
        AND json_extract(NEW.close_result, '$.status') = NEW.close_status
        AND (
            (NEW.close_status < 400 AND json_type(NEW.close_result, '$.problem') IS NULL)
            OR (
                NEW.close_status >= 400
                AND json_type(NEW.close_result, '$.problem') = 'object'
                AND json_extract(NEW.close_result, '$.problem.status') = NEW.close_status
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'subscription terminal result violates the operation-result contract');
END;

CREATE TRIGGER IF NOT EXISTS subscriptions_result_contract_update
BEFORE UPDATE OF closed_at, close_status, close_result ON subscriptions
WHEN NOT (
    (NEW.closed_at IS NULL AND NEW.close_status IS NULL AND NEW.close_result IS NULL)
    OR (
        NEW.closed_at IS NOT NULL
        AND NEW.close_status IS NOT NULL
        AND NEW.close_result IS NOT NULL
        AND json_valid(NEW.close_result)
        AND json_type(NEW.close_result, '$.status') = 'integer'
        AND json_extract(NEW.close_result, '$.status') = NEW.close_status
        AND (
            (NEW.close_status < 400 AND json_type(NEW.close_result, '$.problem') IS NULL)
            OR (
                NEW.close_status >= 400
                AND json_type(NEW.close_result, '$.problem') = 'object'
                AND json_extract(NEW.close_result, '$.problem.status') = NEW.close_status
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'subscription terminal result violates the operation-result contract');
END;

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

-- A branch batch is a durable exclusive transaction over the privileged
-- project repository.
CREATE TABLE IF NOT EXISTS branch_batches (
    id                INTEGER NOT NULL PRIMARY KEY,
    workspace_id      INTEGER NOT NULL,
    parent_worker_id  INTEGER NOT NULL,
    parent_loop_id    INTEGER NOT NULL,
    parent_turn_id    INTEGER NOT NULL UNIQUE,
    state             TEXT    NOT NULL DEFAULT 'collecting'
                      CHECK (state IN ('collecting', 'queued', 'running', 'completed', 'failed', 'recovery_required')),
    active_sequence   INTEGER CHECK (active_sequence IS NULL OR active_sequence >= 1),
    repository_path   TEXT CHECK (repository_path IS NULL OR length(repository_path) > 0),
    original_ref      TEXT,
    original_commit   TEXT CHECK (original_commit IS NULL OR length(original_commit) > 0),
    problem           TEXT CHECK (problem IS NULL OR json_valid(problem)),
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at      TEXT,
    CHECK (
        (repository_path IS NULL AND original_commit IS NULL)
        OR (repository_path IS NOT NULL AND original_commit IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_loop_id) REFERENCES loops(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS branch_batches_one_active_per_workspace
    ON branch_batches (workspace_id)
    WHERE state IN ('collecting', 'queued', 'running', 'recovery_required');

CREATE TABLE IF NOT EXISTS branch_batch_items (
    id            INTEGER NOT NULL PRIMARY KEY,
    batch_id      INTEGER NOT NULL,
    sequence      INTEGER NOT NULL CHECK (sequence >= 1),
    worker_id     INTEGER NOT NULL,
    loop_id       INTEGER NOT NULL,
    branch        TEXT    NOT NULL CHECK (length(branch) > 0),
    state         TEXT    NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'recovery_required')),
    result        TEXT CHECK (result IS NULL OR json_valid(result)),
    result_commit TEXT CHECK (result_commit IS NULL OR length(result_commit) > 0),
    changed       INTEGER CHECK (changed IS NULL OR changed IN (0, 1)),
    started_at    TEXT,
    completed_at  TEXT,
    UNIQUE (batch_id, sequence),
    UNIQUE (batch_id, branch),
    FOREIGN KEY (batch_id) REFERENCES branch_batches(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
) STRICT;
