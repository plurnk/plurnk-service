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
    project_root              TEXT,
    -- {§operator-config} validated client workspace settings; each field composes
    -- with operator configuration at its owning use site.
    settings                  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(settings))
) STRICT;

CREATE INDEX IF NOT EXISTS workspaces_created_at ON workspaces (created_at);

-- {§module-workspace-state}: one opaque, provider-validated JSON snapshot per
-- module owner and workspace. Core owns isolation and lifecycle only.
CREATE TABLE IF NOT EXISTS workspace_module_state (
    workspace_id       INTEGER NOT NULL,
    namespace_owner    TEXT    NOT NULL CHECK (length(namespace_owner) > 0),
    state              TEXT    NOT NULL CHECK (json_valid(state)),
    updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (workspace_id, namespace_owner),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

-- model_routes — the immutable resolved model route ({§worker-model-selection}). One row per
-- complete resolved tuple; append-only. `base_url` uses '' as the absent sentinel so the
-- unique tuple works under SQLite (NULLs are distinct in UNIQUE).
CREATE TABLE IF NOT EXISTS model_routes (
    id         INTEGER NOT NULL PRIMARY KEY,
    alias      TEXT    NOT NULL CHECK (length(alias) > 0),
    provider   TEXT    NOT NULL CHECK (length(provider) > 0),
    model      TEXT    NOT NULL CHECK (length(model) > 0),
    base_url   TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (alias, provider, model, base_url)
) STRICT;

-- workers
CREATE TABLE IF NOT EXISTS workers (
    id              INTEGER NOT NULL PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    workspace_id    INTEGER NOT NULL,
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
    -- workers fork via parent_worker_id; workspaces carry no parent — {§machine-processes-no-fork-workspace}
    parent_worker_id INTEGER          CHECK (parent_worker_id IS NULL OR parent_worker_id != id),
    origin          TEXT    NOT NULL DEFAULT 'client' CHECK (origin IN ('model', 'client', '_plurnk')),
    -- {§methods-model-worker}: durable identity for the workspace's stable
    -- default conversation; unrelated to its human-facing, reclaimable name.
    default_conversation INTEGER NOT NULL DEFAULT 0 CHECK (default_conversation IN (0, 1)),
    -- {§worker-settings}: the worker's own behavioral rules inside the workspace's
    -- world — the workspace is how things are; each worker carries the rules its
    -- loops obey. Client-declared at worker creation, mutable between loops,
    -- validated at the client-input boundary (closed known-key set; unknown keys
    -- never persist).
    settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
    -- {§env-delta-log-pull}: monotonic observation progress, not a private world snapshot.
    -- NULL means the worker has not established its first-turn baseline yet.
    ambient_event_cursor INTEGER      CHECK (ambient_event_cursor IS NULL OR ambient_event_cursor >= 0),
    CHECK (default_conversation = 0 OR (origin = 'model' AND parent_worker_id IS NULL)),
    FOREIGN KEY (workspace_id)    REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_worker_id) REFERENCES workers(id)     ON DELETE CASCADE
) STRICT;

CREATE        INDEX IF NOT EXISTS workers_workspace_id_created_at ON workers (workspace_id, created_at);
CREATE        INDEX IF NOT EXISTS workers_parent_worker_id         ON workers (parent_worker_id);
CREATE UNIQUE INDEX IF NOT EXISTS workers_provider_identity         ON workers (provider_identity);
CREATE UNIQUE INDEX IF NOT EXISTS workers_workspace_default_conversation
    ON workers (workspace_id) WHERE default_conversation = 1;
-- NOT unique: a name is frozen per worker ({§machine-processes-worker-origin}) but RECLAIMABLE across
-- time — a terminated worker keeps its name in permanent history while a fresh spawn reuses it;
-- worker_resolve_by_name picks the newest. A LIVE collision is refused at the spawn gate (Worker.edit
-- → worker_live_by_name → 409), never by this index. Indexed for the by-name resolve/spawn lookup.
CREATE        INDEX IF NOT EXISTS workers_workspace_name          ON workers (workspace_id, name);

CREATE TRIGGER IF NOT EXISTS workers_provider_identity_immutable
BEFORE UPDATE OF provider_identity ON workers
WHEN NEW.provider_identity != OLD.provider_identity
BEGIN
    SELECT RAISE(ABORT, 'workers.provider_identity is immutable');
END;

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
    tags               TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
    status_rx          INTEGER NOT NULL CHECK (status_rx BETWEEN 100 AND 599),
    terminated_by      TEXT             CHECK (terminated_by IS NULL OR terminated_by = 'cancel'),
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
        (kind = 'edit' AND op = 'EDIT' AND rx IS NOT NULL AND terminated_by IS NULL)
        OR
        (kind = 'loop_termination'
            AND op = 'SEND'
            AND scheme = 'worker'
            AND rx IS NOT NULL
            AND json_valid(rx)
            AND json_type(rx) = 'object'
            AND json_type(rx, '$.status') = 'integer'
            AND json_extract(rx, '$.status') = status_rx)
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
    -- {§worker-model-selection}: immutable loop snapshots of the resolved model route and the
    -- effective spawn route (was provider_spec/child_provider_spec JSON).
    model_route_id       INTEGER          REFERENCES model_routes(id),
    spawn_model_route_id INTEGER          REFERENCES model_routes(id),
    max_turns INTEGER NOT NULL DEFAULT 50 CHECK (max_turns >= -1),
    -- {§methods-loop-run-open-paths}: the initial prompt frame's selected paths,
    -- held here until turn 1 materializes that frame (string[] JSON).
    open_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_paths)),
    -- {§prompt-loop-containment}: one queued recovery loop may carry the
    -- complete orphan frame set of one concluded source loop.
    orphan_source_loop_id INTEGER,
    -- {§worker-scheme} loop-termination delta: terminated_at is stamped by the trigger
    -- below when status crosses into terminal (every death-path, uniformly).
    terminated_at    TEXT,
    terminal_result  TEXT,
    -- {§loop-terminal-authorship}: 'cancel' names an external loop.cancel;
    -- NULL covers model terminals and engine verdicts whose result carries the story.
    terminated_by    TEXT                      CHECK (terminated_by IS NULL OR terminated_by = 'cancel'),
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
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (orphan_source_loop_id) REFERENCES loops(id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS loops_worker_id_sequence ON loops (worker_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS loops_orphan_source_loop_id ON loops (orphan_source_loop_id);
-- {§worker-scheme}: a loop crossing into a terminal status stamps terminated_at, so sibling
-- workers pull the termination as a folded ambient delta — caught uniformly across every
-- death-path (SEND, overflow recovery, max-turns, strike, KILL). The stamp updates terminated_at,
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
        op, scheme, pathname, rx, status_rx, terminated_by
    )
    SELECT w.workspace_id, NEW.worker_id, 'loop_termination', NEW.id, NULL,
           'SEND', 'worker', '/' || w.name, NEW.terminal_result,
           json_extract(NEW.terminal_result, '$.status'), NEW.terminated_by
    FROM workers w
    WHERE w.id = NEW.worker_id;
END;

-- turns
-- finish_reason / model: accepted provider-call metadata from the provider
-- response contract. Physical request accounting is normalized beneath the
-- logical emission attempt that caused it.
CREATE TABLE IF NOT EXISTS turns (
    id               INTEGER NOT NULL PRIMARY KEY,
    version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    loop_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL           CHECK (sequence >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    status           INTEGER NOT NULL           CHECK (status BETWEEN 100 AND 599),
    -- Provider-derived curation calibration for this turn; NULL when input
    -- capacity is unknown. {§tokenomics-client-gauge}
    usage_curation_budget INTEGER                CHECK (usage_curation_budget IS NULL OR usage_curation_budget >= 1),
    -- {§packet-stored-shape}: NULL means no model request was assembled. A
    -- present packet is either the measured request or that request extended
    -- by the paired admitted-response fields.
    packet           TEXT                       CHECK (
        CASE
            WHEN packet IS NULL THEN 1
            WHEN json_valid(packet) = 0 THEN 0
            ELSE COALESCE(
                json_type(packet) = 'object'
                AND json_type(packet, '$.weight') = 'integer'
                AND json_extract(packet, '$.weight') >= 0
                AND json_type(packet, '$.sections') = 'array'
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
    model            TEXT    NOT NULL DEFAULT 'unknown' CHECK (length(model) >= 1),
    -- Opaque provider→client metadata plus engine rail keys; JSON-valid but
    -- otherwise unenforced. {§meta-passthrough}, {§rail-truth-engine-verdict}
    meta             TEXT    NOT NULL DEFAULT '{}'     CHECK (json_valid(meta)),
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS turns_loop_id_sequence ON turns (loop_id, sequence);
CREATE        INDEX IF NOT EXISTS turns_timestamp        ON turns (timestamp);

-- One logical provider.generate call. Emission attempts and BARE inferences
-- share response/failure evidence and cardinal physical request accounting;
-- operation-specific semantics live in their specializing relations.
CREATE TABLE IF NOT EXISTS model_calls (
    id               INTEGER NOT NULL PRIMARY KEY,
    turn_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL CHECK (sequence >= 1),
    kind             TEXT    NOT NULL CHECK (kind IN ('emission', 'bare')),
    state            TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'response', 'error')),
    response         TEXT             CHECK (response IS NULL OR json_valid(response)),
    failure          TEXT             CHECK (failure IS NULL OR json_valid(failure)),
    -- Request-shaped provider capacity evidence. A completed response always
    -- has it; a pre-I/O or transport failure may retain it without fabricating
    -- physical usage.
    capacity         TEXT             CHECK (
        capacity IS NULL OR (json_valid(capacity) AND json_type(capacity) = 'object')
    ),
    -- Exact opaque tag set forwarded with this provider call.
    -- {§attribution}
    attributions     TEXT    NOT NULL DEFAULT '[]' CHECK (
        json_valid(attributions) AND json_type(attributions) = 'array'
    ),
    finish_reason    TEXT,
    model            TEXT    NOT NULL CHECK (length(model) >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at     TEXT,
    CHECK (
        (state = 'pending'
            AND response IS NULL AND failure IS NULL
            AND capacity IS NULL
            AND finish_reason IS NULL AND completed_at IS NULL)
        OR
        (state = 'response'
            AND response IS NOT NULL
            AND capacity IS NOT NULL
            AND completed_at IS NOT NULL)
        OR
        (state = 'error'
            AND response IS NULL AND failure IS NOT NULL
            AND completed_at IS NOT NULL)
    ),
    UNIQUE (turn_id, sequence),
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS model_calls_turn_id ON model_calls (turn_id, sequence);

CREATE TRIGGER IF NOT EXISTS model_calls_request_identity_immutable
BEFORE UPDATE OF turn_id, sequence, kind, attributions, timestamp ON model_calls
BEGIN
    SELECT RAISE(ABORT, 'model call request identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS model_calls_state_forward_only
BEFORE UPDATE OF state ON model_calls
WHEN NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'pending' AND NEW.state IN ('response', 'error'))
)
BEGIN
    SELECT RAISE(ABORT, 'model call state may only close once');
END;

CREATE TRIGGER IF NOT EXISTS model_calls_observation_immutable
BEFORE UPDATE OF response, failure, capacity, finish_reason, model, completed_at
ON model_calls
WHEN OLD.state != 'pending'
BEGIN
    SELECT RAISE(ABORT, 'model call observation is immutable');
END;

-- Emission admission specializes one model call without re-owning its response,
-- provider identity, ordering, or accounting evidence.
CREATE TABLE IF NOT EXISTS turn_attempts (
    id               INTEGER NOT NULL PRIMARY KEY,
    model_call_id    INTEGER NOT NULL UNIQUE,
    accepted         INTEGER          CHECK (accepted IS NULL OR accepted IN (0, 1)),
    parse_errors     TEXT    NOT NULL DEFAULT '[]' CHECK (
        json_valid(parse_errors) AND json_type(parse_errors) = 'array'
    ),
    FOREIGN KEY (model_call_id) REFERENCES model_calls(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER IF NOT EXISTS turn_attempts_request_identity_immutable
BEFORE UPDATE OF model_call_id ON turn_attempts
BEGIN
    SELECT RAISE(ABORT, 'emission attempt identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_emission_call_only
BEFORE INSERT ON turn_attempts
WHEN COALESCE((SELECT kind = 'emission' FROM model_calls WHERE id = NEW.model_call_id), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'turn attempt requires an emission model call');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_classification_after_response
BEFORE UPDATE OF accepted, parse_errors ON turn_attempts
WHEN COALESCE((SELECT state = 'response' FROM model_calls WHERE id = OLD.model_call_id), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'emission classification requires model response evidence');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_classification_once
BEFORE UPDATE OF accepted, parse_errors
ON turn_attempts
WHEN OLD.accepted IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'emission attempt classification is immutable');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_one_accepted_insert
BEFORE INSERT ON turn_attempts
WHEN NEW.accepted = 1 AND EXISTS (
    SELECT 1
    FROM turn_attempts existing
    JOIN model_calls old_call ON old_call.id = existing.model_call_id
    JOIN model_calls new_call ON new_call.id = NEW.model_call_id
    WHERE old_call.turn_id = new_call.turn_id AND existing.accepted = 1
)
BEGIN
    SELECT RAISE(ABORT, 'one emission may be accepted per turn');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_one_accepted_update
BEFORE UPDATE OF accepted ON turn_attempts
WHEN NEW.accepted = 1 AND EXISTS (
    SELECT 1
    FROM turn_attempts existing
    JOIN model_calls old_call ON old_call.id = existing.model_call_id
    JOIN model_calls new_call ON new_call.id = NEW.model_call_id
    WHERE old_call.turn_id = new_call.turn_id
      AND existing.id != OLD.id
      AND existing.accepted = 1
)
BEGIN
    SELECT RAISE(ABORT, 'one emission may be accepted per turn');
END;

-- {§provider-request-accounting}: one row is opened before one physical
-- provider request and settled exactly once with the evidence from that request.
-- Monetary values remain canonical decimal strings; SQLite REAL is never an
-- accounting representation.
CREATE TABLE IF NOT EXISTS provider_requests (
    id                       INTEGER NOT NULL PRIMARY KEY,
    model_call_id            INTEGER NOT NULL,
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
    UNIQUE (model_call_id, sequence),
    FOREIGN KEY (model_call_id) REFERENCES model_calls(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS provider_requests_model_call_id
    ON provider_requests (model_call_id, sequence);

CREATE TRIGGER IF NOT EXISTS provider_requests_identity_immutable
BEFORE UPDATE OF model_call_id, sequence, provider, model, started_at ON provider_requests
BEGIN
    SELECT RAISE(ABORT, 'provider request identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS provider_requests_state_forward_only
BEFORE UPDATE OF state ON provider_requests
WHEN NOT (NEW.state = OLD.state OR (OLD.state = 'pending' AND NEW.state = 'settled'))
BEGIN
    SELECT RAISE(ABORT, 'provider request may only settle once');
END;

CREATE TRIGGER IF NOT EXISTS provider_requests_settlement_immutable
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

-- derivations
-- Content-addressed deep projections. Entry channels and log projections point
-- at a COMPLETE artifact by deep_hash; graph, FTS, and vectors are stored once
-- regardless of how many addresses carry identical content under the same reader/config.
-- A building row is unattached and safely replaceable after interruption.
CREATE TABLE IF NOT EXISTS derivations (
    id          INTEGER NOT NULL PRIMARY KEY,
    deep_hash   TEXT    NOT NULL UNIQUE CHECK (length(deep_hash) > 0),
    state       TEXT    NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'complete')),
    disposition TEXT    CHECK (disposition IN ('vector', 'lexical', 'excluded', 'nonsemantic', 'failed')),
    reason      TEXT,
    parse_issues INTEGER CHECK (parse_issues IS NULL OR parse_issues > 0),
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
    -- SPEC {§membership-change-gated-sync} — the per-member sync stat-detect:
    -- "<mtimeMs>:<size>" of the disk file at its last materialization, or `absent`
    -- after an observed deletion. The pre-turn
    -- sync stat()s every member but re-reads/re-tokenizes/rewrites only one whose
    -- signature changed; an unchanged member is a no-op. NULL = never synced.
    synced_sig TEXT,
    -- User Note 5 — manifest cache-friendliness. Last-modified stamp, bumped on every
    -- addressable representation change; engine_list_workspace_entries orders the catalog
    -- by it ASC so dormant entries hold the stable prompt-cache prefix. Private derivation
    -- attachment does not make an entry recently touched.
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (workspace_id IS NOT NULL),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id)     REFERENCES workers(id)    ON DELETE CASCADE
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
    weight   INTEGER NOT NULL DEFAULT 0   CHECK (weight >= 0),
    -- Content identity: sha256 of content, stamped at static writes; streamed
    -- appends leave it NULL. Curation weight remains model-independent.
    content_hash TEXT,
    -- Search derivation for this exact addressable channel representation.
    -- Content or mimetype changes invalidate it at the owning channel row.
    deep_hash TEXT,
    state    TEXT    NOT NULL DEFAULT 'static' CHECK (state IN ('static', 'active', 'closed', 'errored')),
    -- Exact terminal producer evidence for this representation channel. NULL is
    -- the ordinary implicit {status:200}; selection/projection metadata belongs
    -- to core and is never stored here.
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
    PRIMARY KEY (entry_id, name),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (deep_hash) REFERENCES derivations(deep_hash)
) STRICT, WITHOUT ROWID;

-- A changed channel representation cannot retain search evidence derived from
-- its predecessor. This trigger is the one invalidation owner for every write
-- path, including model EDIT, plugin channel capabilities, and streams.
CREATE TRIGGER IF NOT EXISTS entry_channels_invalidate_derivation
AFTER UPDATE OF content, mimetype ON entry_channels
WHEN OLD.content IS NOT NEW.content OR OLD.mimetype IS NOT NEW.mimetype
BEGIN
    UPDATE entry_channels
    SET deep_hash = NULL
    WHERE entry_id = NEW.entry_id AND name = NEW.name AND deep_hash IS NOT NULL;
END;

-- User Note 5 — bump the entry's updated_at on addressable representation or
-- lifecycle writes so the catalog (ordered by updated_at ASC) keeps recently-
-- touched entries at the tail and holds the prompt-cache prefix stable across
-- turns. Content hashes and search attachments are private metadata, not touches.
CREATE TRIGGER IF NOT EXISTS entries_touch_on_channel_write
AFTER INSERT ON entry_channels
BEGIN
    UPDATE entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.entry_id;
END;

CREATE TRIGGER IF NOT EXISTS entries_touch_on_channel_update
AFTER UPDATE OF content, mimetype, weight, state, producer_result ON entry_channels
BEGIN
    UPDATE entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.entry_id;
END;

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
-- folded: canonical hidden log-body line intervals for OPEN/FOLD. [] is
-- wholly open and [[1,-1]] is wholly folded.
CREATE TABLE IF NOT EXISTS log_entries (
    id              INTEGER NOT NULL PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),

    worker_id          INTEGER NOT NULL,
    loop_id         INTEGER NOT NULL,
    turn_id         INTEGER NOT NULL,
    sequence        INTEGER NOT NULL           CHECK (sequence >= 1),
    at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    origin          TEXT    NOT NULL           CHECK (origin IN ('model', 'client', '_plurnk', 'plugin')),
    -- {§env-delta-attribution}: a worker:// name or stable subsystem token ('file');
    -- NULL = the owning worker itself, rendered without causal attribution.
    source          TEXT,
    -- Engine-owned occurrence identity. Source rows are stamped NULL→id by the
    -- journal trigger; observer and fork copies carry it at insertion.
    ambient_event_id INTEGER                  REFERENCES ambient_events(id),
    -- Search derivation attached to this durable log result, when available.
    deep_hash       TEXT                       REFERENCES derivations(deep_hash),
    -- Exact logical provider call represented by a BARE result or model-emission
    -- mirror. Other operation and ambient rows carry no model-call identity.
    model_call_id   INTEGER                    REFERENCES model_calls(id),

    -- 'error' is an ACTIONLESS row ({§operation-results} — errors are log items): a parse failure that
    -- produced no op still records a log entry (op='error', status_rx≥400, no target) so the model
    -- can fold/kill/recall its own mistakes like any other log row — one budget surface, the log.
    -- Actionless artifacts carry NULL here: kernel-authored worker initialization
    -- or overflow recovery ({§worker-initialization-entry}, {§overflow-turn-receipt}),
    -- or a model emission ({§model-entry}).
    -- No op enum here: the grammar op set is grammar's contract (PlurnkOp), and this column is written
    -- only by the PlurnkOp-typed engine (grammar ops), service row selectors, or NULL for no op.
    -- A SQL enum would be a hand-copy of grammar's op list that silently goes stale on every new verb
    -- (it did — FORK/WORK). Validity lives at the parse + type layer, not duplicated in DDL.
    op              TEXT,
    delimiter          TEXT    NOT NULL DEFAULT '',
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

    -- Complete canonical LogBody content before coordinate/presentation
    -- projection; persistence envelopes do not contribute. {§tokenomics-weight-stored-at-write}
    weight          INTEGER NOT NULL DEFAULT 0 CHECK (weight >= 0),

    state           TEXT    NOT NULL DEFAULT 'resolved'
                    CHECK (state IN ('proposed', 'resolved', 'failed', 'cancelled')),
    outcome         TEXT,
    attrs           TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),

    folded           TEXT    NOT NULL DEFAULT '[]'
                    CHECK (json_valid(folded) AND json_type(folded) = 'array'),

    CHECK ((op IS NULL) = COALESCE(json_extract(attrs, '$.kind') IN ('initialization', 'overflow', 'model_emission'), 0)),
    CHECK (json_extract(attrs, '$.kind') NOT IN ('initialization', 'overflow') OR origin = '_plurnk'),
    CHECK (json_extract(attrs, '$.kind') != 'model_emission' OR origin = 'model'),

    FOREIGN KEY (worker_id)  REFERENCES workers(id)  ON DELETE CASCADE,
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS log_entries_turn_id_sequence ON log_entries (turn_id, sequence);
CREATE        INDEX IF NOT EXISTS log_entries_worker_id           ON log_entries (worker_id);
CREATE        INDEX IF NOT EXISTS log_entries_loop_id          ON log_entries (loop_id);
CREATE        INDEX IF NOT EXISTS log_entries_at               ON log_entries (at);
CREATE UNIQUE INDEX IF NOT EXISTS log_entries_model_call_id
    ON log_entries (model_call_id)
    WHERE model_call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS log_entries_worker_ambient_event
    ON log_entries (worker_id, ambient_event_id)
    WHERE ambient_event_id IS NOT NULL;

-- A folded interval is an inclusive [start,end] pair. Ranges are positive,
-- sorted, disjoint, and non-adjacent; -1 is the final open-ended endpoint.
-- Canonical intervals make visibility equality and curation effects exact.
CREATE TRIGGER IF NOT EXISTS log_entries_folded_valid_insert
BEFORE INSERT ON log_entries
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
    SELECT RAISE(ABORT, 'log entry folded ranges are invalid');
END;

CREATE TRIGGER IF NOT EXISTS log_entries_folded_valid_update
BEFORE UPDATE OF folded ON log_entries
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
    SELECT RAISE(ABORT, 'log entry folded ranges are invalid');
END;

CREATE TRIGGER IF NOT EXISTS log_entries_model_call_valid
BEFORE INSERT ON log_entries
WHEN NEW.model_call_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM model_calls call
    WHERE call.id = NEW.model_call_id
      AND call.turn_id = NEW.turn_id
      AND call.state != 'pending'
      AND (
          (call.kind = 'bare' AND NEW.op = 'BARE')
          OR (
              call.kind = 'emission'
              AND NEW.op IS NULL
              AND json_extract(NEW.attrs, '$.kind') = 'model_emission'
          )
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'log entry model call does not match its represented result');
END;

-- {§log-item-tags} — log classification plus OPEN/FOLD selection and mutation.
-- CASCADE erases the classification with its row.
CREATE TABLE IF NOT EXISTS log_tags (
    log_entry_id INTEGER NOT NULL,
    tag          TEXT    NOT NULL,
    PRIMARY KEY (log_entry_id, tag),
    FOREIGN KEY (log_entry_id) REFERENCES log_entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- The relational table owns stored tag identity. Producers and curation
-- signals carry signs, but the stored name never does; delimiters, whitespace,
-- and control characters cannot become durable classifications through a
-- private SQL caller either.
CREATE TRIGGER IF NOT EXISTS log_tags_name_valid
BEFORE INSERT ON log_tags
WHEN length(NEW.tag) = 0
  OR substr(NEW.tag, 1, 1) IN ('+', '-')
  OR instr(NEW.tag, '[') > 0
  OR instr(NEW.tag, ']') > 0
  OR instr(NEW.tag, ',') > 0
  OR instr(NEW.tag, char(0)) > 0
  OR EXISTS (
      WITH RECURSIVE offsets(position) AS (
          SELECT 1
          UNION ALL
          SELECT position + 1 FROM offsets WHERE position < length(NEW.tag)
      )
      SELECT 1
      FROM offsets
      WHERE unicode(substr(NEW.tag, position, 1)) BETWEEN 0 AND 32
         OR unicode(substr(NEW.tag, position, 1)) BETWEEN 127 AND 159
         OR unicode(substr(NEW.tag, position, 1)) IN (160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
         OR unicode(substr(NEW.tag, position, 1)) BETWEEN 8192 AND 8202
  )
BEGIN
    SELECT RAISE(ABORT, 'log tag name is invalid');
END;

CREATE INDEX IF NOT EXISTS log_tags_tag ON log_tags (tag);

-- Signal-derived classification is part of the log-row insert, not a later JS
-- write. This keeps the operation, its ambient occurrence, and its complete
-- initial folksonomy inside one SQLite commit.
CREATE TRIGGER IF NOT EXISTS log_entries_classify_signal
AFTER INSERT ON log_entries
WHEN NEW.op IN ('FIND', 'READ', 'EDIT', 'COPY', 'MOVE', 'BARE')
 AND NEW.signal IS NOT NULL
BEGIN
    SELECT CASE
        WHEN json_type(NEW.signal) != 'array'
          OR EXISTS (
              SELECT 1 FROM json_each(NEW.signal)
              WHERE type != 'text'
                 OR length(value) = 0
                 OR substr(value, 1, 1) = '-'
                 OR (
                    substr(value, 1, 1) = '+'
                    AND (length(value) < 2 OR substr(value, 2, 1) IN ('+', '-'))
                 )
                 OR instr(value, '[') > 0
                 OR instr(value, ']') > 0
                 OR instr(value, ',') > 0
                 OR instr(value, char(0)) > 0
                 OR EXISTS (
                     WITH RECURSIVE offsets(position) AS (
                         SELECT 1
                         UNION ALL
                         SELECT position + 1 FROM offsets WHERE position < length(value)
                     )
                     SELECT 1
                     FROM offsets
                     WHERE unicode(substr(value, position, 1)) BETWEEN 0 AND 32
                        OR unicode(substr(value, position, 1)) BETWEEN 127 AND 159
                        OR unicode(substr(value, position, 1)) IN (160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
                        OR unicode(substr(value, position, 1)) BETWEEN 8192 AND 8202
                 )
          )
        THEN RAISE(ABORT, 'classifying log operation signal accepts only tag or +tag additions')
    END;
    INSERT OR IGNORE INTO log_tags (log_entry_id, tag)
    SELECT NEW.id, CASE WHEN substr(value, 1, 1) = '+' THEN substr(value, 2) ELSE value END
    FROM json_each(NEW.signal);

    -- The ambient-event and classification AFTER INSERT triggers may run in
    -- either order. If the event already exists, finish its initial
    -- snapshot here; otherwise its own trigger aggregates these rows later.
    UPDATE ambient_events
    SET tags = COALESCE((
        SELECT json_group_array(tag)
        FROM (SELECT tag FROM log_tags WHERE log_entry_id = NEW.id ORDER BY tag)
    ), '[]')
    WHERE kind = 'edit'
      AND producer_worker_id = NEW.worker_id
      AND source_record_id = NEW.id;
END;

-- {§worker-initialization-entry} {§overflow-turn-receipt} — kernel receipts
-- are structurally self-classifying. Their immutable provenance and mutable
-- folksonomy therefore cannot drift apart through a caller omission.
CREATE TRIGGER IF NOT EXISTS log_entries_classify_plurnk_actionless
AFTER INSERT ON log_entries
WHEN NEW.op IS NULL
 AND NEW.origin = '_plurnk'
 AND json_extract(NEW.attrs, '$.kind') IN ('initialization', 'overflow')
BEGIN
    INSERT INTO log_tags (log_entry_id, tag)
    VALUES (NEW.id, '_plurnk');
    INSERT INTO log_tags (log_entry_id, tag)
    VALUES (
        NEW.id,
        CASE json_extract(NEW.attrs, '$.kind')
            WHEN 'initialization' THEN 'init'
            ELSE 'overflow'
        END
    );
END;

-- Successful OPEN/FOLD rows are durable curation events even though their
-- ordinary packet projection is suppressed ({§fold-open-meta-operations}).
-- Preserve the exact selected set and each target's before/after visibility so a
-- broad selector never collapses into the lossy fact `matched: N`.
CREATE TABLE IF NOT EXISTS log_curation_effects (
    operation_log_entry_id INTEGER NOT NULL,
    target_log_entry_id    INTEGER NOT NULL,
    folded_before          TEXT    NOT NULL
                                  CHECK (json_valid(folded_before) AND json_type(folded_before) = 'array'),
    folded_after           TEXT    NOT NULL
                                  CHECK (json_valid(folded_after) AND json_type(folded_after) = 'array'),
    tags_added             TEXT    NOT NULL DEFAULT '[]'
                                  CHECK (json_valid(tags_added) AND json_type(tags_added) = 'array'),
    tags_removed           TEXT    NOT NULL DEFAULT '[]'
                                  CHECK (json_valid(tags_removed) AND json_type(tags_removed) = 'array'),
    PRIMARY KEY (operation_log_entry_id, target_log_entry_id),
    CHECK (operation_log_entry_id != target_log_entry_id),
    FOREIGN KEY (operation_log_entry_id) REFERENCES log_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (target_log_entry_id)    REFERENCES log_entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS log_curation_effects_target
    ON log_curation_effects (target_log_entry_id);

-- Make an invalid curation record structurally unavailable: the event must be
-- one successful OPEN/FOLD row, both rows must belong to the same worker, and
-- both exact delta sets must contain only unique canonical tag identities.
CREATE TRIGGER IF NOT EXISTS log_curation_effects_valid
BEFORE INSERT ON log_curation_effects
BEGIN
    SELECT CASE WHEN
        NOT EXISTS (
            SELECT 1
            FROM log_entries operation
            JOIN log_entries target ON target.id = NEW.target_log_entry_id
            WHERE operation.id = NEW.operation_log_entry_id
              AND operation.op IN ('OPEN', 'FOLD')
              AND operation.status_rx < 400
              AND operation.worker_id = target.worker_id
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
        OR EXISTS (
            SELECT 1
            FROM (
                SELECT value, type FROM json_each(NEW.tags_added)
                UNION ALL
                SELECT value, type FROM json_each(NEW.tags_removed)
            ) tag
            WHERE tag.type != 'text'
               OR length(tag.value) = 0
               OR substr(tag.value, 1, 1) IN ('+', '-')
               OR instr(tag.value, '[') > 0
               OR instr(tag.value, ']') > 0
               OR instr(tag.value, ',') > 0
               OR instr(tag.value, char(0)) > 0
               OR EXISTS (
                   WITH RECURSIVE offsets(position) AS (
                       SELECT 1
                       UNION ALL
                       SELECT position + 1 FROM offsets WHERE position < length(tag.value)
                   )
                   SELECT 1
                   FROM offsets
                   WHERE unicode(substr(tag.value, position, 1)) BETWEEN 0 AND 32
                      OR unicode(substr(tag.value, position, 1)) BETWEEN 127 AND 159
                      OR unicode(substr(tag.value, position, 1)) IN (160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
                      OR unicode(substr(tag.value, position, 1)) BETWEEN 8192 AND 8202
               )
        )
        OR (SELECT COUNT(*) FROM json_each(NEW.tags_added))
           != (SELECT COUNT(DISTINCT value) FROM json_each(NEW.tags_added))
        OR (SELECT COUNT(*) FROM json_each(NEW.tags_removed))
           != (SELECT COUNT(DISTINCT value) FROM json_each(NEW.tags_removed))
        OR EXISTS (
            SELECT 1
            FROM json_each(NEW.tags_added) addition
            JOIN json_each(NEW.tags_removed) removal ON removal.value = addition.value
        )
    THEN RAISE(ABORT, 'invalid log curation effect') END;
END;

-- The dispatcher binds an exact, transient curation plan into attrs on the
-- successful OPEN/FOLD row. No other row may carry that private payload.
CREATE TRIGGER IF NOT EXISTS log_entries_curation_payload_valid
BEFORE INSERT ON log_entries
WHEN json_type(NEW.attrs, '$.__plurnk_curation') IS NOT NULL
 AND NOT (
    NEW.op IN ('OPEN', 'FOLD')
    AND NEW.status_rx < 400
    AND json_type(NEW.attrs, '$.__plurnk_curation') = 'object'
 )
BEGIN
    SELECT RAISE(ABORT, 'private log curation payload requires a successful OPEN/FOLD row');
END;

-- One outer INSERT owns the whole landed curation event: exact selected rows,
-- their before/after visibility and tag deltas, and the
-- resulting classifications. Trigger failure rolls the operation row and all
-- effects back together. The private plan is erased before INSERT returns.
CREATE TRIGGER IF NOT EXISTS log_entries_apply_curation
AFTER INSERT ON log_entries
WHEN NEW.op IN ('OPEN', 'FOLD')
 AND NEW.status_rx < 400
 AND json_type(NEW.attrs, '$.__plurnk_curation') = 'object'
BEGIN
    SELECT CASE WHEN
        COALESCE(json_type(NEW.attrs, '$.__plurnk_curation.targets'), '') != 'array'
        OR COALESCE(json_type(NEW.attrs, '$.__plurnk_curation.add'), '') != 'array'
        OR COALESCE(json_type(NEW.attrs, '$.__plurnk_curation.remove'), '') != 'array'
        OR json_array_length(NEW.attrs, '$.__plurnk_curation.targets') = 0
        OR EXISTS (
            SELECT 1
            FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
            WHERE selected.type != 'object'
               OR COALESCE(json_type(selected.value, '$.id'), '') != 'integer'
               OR json_extract(selected.value, '$.id') <= 0
               OR COALESCE(json_type(selected.value, '$.before'), '') != 'array'
               OR COALESCE(json_type(selected.value, '$.after'), '') != 'array'
               OR EXISTS (
                   SELECT 1 FROM json_each(selected.value) field
                   WHERE field.key NOT IN ('id', 'before', 'after')
               )
               OR EXISTS (
                   SELECT 1
                   FROM (
                       SELECT 'before' AS side, range.key, range.value, range.type
                       FROM json_each(json_extract(selected.value, '$.before')) range
                       UNION ALL
                       SELECT 'after' AS side, range.key, range.value, range.type
                       FROM json_each(json_extract(selected.value, '$.after')) range
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
                          FROM json_each(
                              CASE range.side
                                  WHEN 'before' THEN json_extract(selected.value, '$.before')
                                  ELSE json_extract(selected.value, '$.after')
                              END
                          ) previous
                          WHERE previous.key = range.key - 1
                            AND (
                                json_extract(previous.value, '$[1]') = -1
                                OR json_extract(range.value, '$[0]') <= json_extract(previous.value, '$[1]') + 1
                            )
                      )
               )
        )
        OR (
            SELECT COUNT(*) FROM json_each(NEW.attrs, '$.__plurnk_curation.targets')
        ) != (
            SELECT COUNT(DISTINCT json_extract(value, '$.id'))
            FROM json_each(NEW.attrs, '$.__plurnk_curation.targets')
        )
        OR EXISTS (
            SELECT 1
            FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
            LEFT JOIN log_entries target ON target.id = json_extract(selected.value, '$.id')
            WHERE target.id IS NULL
               OR target.worker_id != NEW.worker_id
               OR target.id = NEW.id
               OR json(target.folded) != json(json_extract(selected.value, '$.before'))
        )
        OR EXISTS (
            SELECT 1
            FROM (
                SELECT value, type FROM json_each(NEW.attrs, '$.__plurnk_curation.add')
                UNION ALL
                SELECT value, type FROM json_each(NEW.attrs, '$.__plurnk_curation.remove')
            ) tag
            WHERE tag.type != 'text'
               OR length(tag.value) = 0
               OR substr(tag.value, 1, 1) IN ('+', '-')
               OR instr(tag.value, '[') > 0
               OR instr(tag.value, ']') > 0
               OR instr(tag.value, ',') > 0
               OR instr(tag.value, char(0)) > 0
               OR EXISTS (
                   WITH RECURSIVE offsets(position) AS (
                       SELECT 1
                       UNION ALL
                       SELECT position + 1 FROM offsets WHERE position < length(tag.value)
                   )
                   SELECT 1
                   FROM offsets
                   WHERE unicode(substr(tag.value, position, 1)) BETWEEN 0 AND 32
                      OR unicode(substr(tag.value, position, 1)) BETWEEN 127 AND 159
                      OR unicode(substr(tag.value, position, 1)) IN (160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
                      OR unicode(substr(tag.value, position, 1)) BETWEEN 8192 AND 8202
               )
        )
        OR (
            SELECT COUNT(*) FROM json_each(NEW.attrs, '$.__plurnk_curation.add')
        ) != (
            SELECT COUNT(DISTINCT value) FROM json_each(NEW.attrs, '$.__plurnk_curation.add')
        )
        OR (
            SELECT COUNT(*) FROM json_each(NEW.attrs, '$.__plurnk_curation.remove')
        ) != (
            SELECT COUNT(DISTINCT value) FROM json_each(NEW.attrs, '$.__plurnk_curation.remove')
        )
        OR EXISTS (
            SELECT 1
            FROM json_each(NEW.attrs, '$.__plurnk_curation.add') addition
            JOIN json_each(NEW.attrs, '$.__plurnk_curation.remove') removal
              ON removal.value = addition.value
        )
    THEN RAISE(ABORT, 'invalid private log curation payload') END;

    INSERT INTO log_curation_effects (
        operation_log_entry_id,
        target_log_entry_id,
        folded_before,
        folded_after,
        tags_added,
        tags_removed
    )
    SELECT
        NEW.id,
        target.id,
        json_extract(selected.value, '$.before'),
        json_extract(selected.value, '$.after'),
        COALESCE((
            SELECT json_group_array(ordered.tag)
            FROM (
                SELECT addition.value AS tag
                FROM json_each(NEW.attrs, '$.__plurnk_curation.add') addition
                WHERE NOT EXISTS (
                    SELECT 1 FROM log_tags
                    WHERE log_entry_id = target.id AND tag = addition.value
                )
                ORDER BY addition.value
            ) ordered
        ), '[]'),
        COALESCE((
            SELECT json_group_array(ordered.tag)
            FROM (
                SELECT removal.value AS tag
                FROM json_each(NEW.attrs, '$.__plurnk_curation.remove') removal
                WHERE EXISTS (
                    SELECT 1 FROM log_tags
                    WHERE log_entry_id = target.id AND tag = removal.value
                )
                ORDER BY removal.value
            ) ordered
        ), '[]')
    FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
    JOIN log_entries target ON target.id = json_extract(selected.value, '$.id');

    UPDATE log_entries
    SET folded = (
        SELECT json_extract(selected.value, '$.after')
        FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
        WHERE json_extract(selected.value, '$.id') = log_entries.id
    )
    WHERE id IN (
        SELECT json_extract(value, '$.id')
        FROM json_each(NEW.attrs, '$.__plurnk_curation.targets')
    );

    DELETE FROM log_tags
    WHERE log_entry_id IN (
        SELECT json_extract(value, '$.id')
        FROM json_each(NEW.attrs, '$.__plurnk_curation.targets')
    )
      AND tag IN (
        SELECT value FROM json_each(NEW.attrs, '$.__plurnk_curation.remove')
    );

    INSERT OR IGNORE INTO log_tags (log_entry_id, tag)
    SELECT json_extract(selected.value, '$.id'), addition.value
    FROM json_each(NEW.attrs, '$.__plurnk_curation.targets') selected
    CROSS JOIN json_each(NEW.attrs, '$.__plurnk_curation.add') addition;

    UPDATE log_entries
    SET attrs = json_remove(attrs, '$.__plurnk_curation')
    WHERE id = NEW.id;
END;

-- Column-scoped immutability: the original action's identity and target never
-- change; the proposal lifecycle is allowed to mutate state, outcome,
-- status_rx, rx, folded. Keep attrs separate so the curation trigger's one
-- private-payload removal cannot exempt changes to any other core column.
CREATE TRIGGER IF NOT EXISTS log_entries_immutable_core
BEFORE UPDATE OF
    worker_id, loop_id, turn_id, sequence, at, origin, source, model_call_id,
    op, delimiter, signal,
    scheme, username, password, hostname,
    port, pathname, query, fragment,
    lineMarker, tx, mimetype_tx, mimetype_rx
ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only state/outcome/status_rx/rx/folded may change');
END;

CREATE TRIGGER IF NOT EXISTS log_entries_immutable_attrs
BEFORE UPDATE OF attrs ON log_entries
WHEN COALESCE((
    json_type(OLD.attrs, '$.__plurnk_curation') = 'object'
    AND NEW.attrs = json_remove(OLD.attrs, '$.__plurnk_curation')
), 0) = 0
BEGIN
    SELECT RAISE(ABORT, 'log_entries attrs are immutable outside curation payload removal');
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
     NEW.origin != '_plurnk'
     OR EXISTS (SELECT 1 FROM workers w WHERE w.id = NEW.worker_id AND w.name = 'plurnk')
 )
BEGIN
    INSERT INTO ambient_events (
        workspace_id, producer_worker_id, kind, source_record_id, source,
        op, scheme, hostname, pathname, rx, attrs, tags, status_rx
    )
    SELECT w.workspace_id, NEW.worker_id, 'edit', NEW.id, NEW.source,
           'EDIT', NEW.scheme, NEW.hostname, NEW.pathname, NEW.rx, NEW.attrs,
           COALESCE((
               SELECT json_group_array(ordered.tag)
               FROM (
                   SELECT tag FROM log_tags WHERE log_entry_id = NEW.id ORDER BY tag
               ) ordered
           ), '[]'),
           NEW.status_rx
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
     NEW.origin != '_plurnk'
     OR EXISTS (SELECT 1 FROM workers w WHERE w.id = NEW.worker_id AND w.name = 'plurnk')
 )
BEGIN
    INSERT INTO ambient_events (
        workspace_id, producer_worker_id, kind, source_record_id, source,
        op, scheme, hostname, pathname, rx, attrs, tags, status_rx
    )
    SELECT w.workspace_id, NEW.worker_id, 'edit', NEW.id, NEW.source,
           'EDIT', NEW.scheme, NEW.hostname, NEW.pathname, NEW.rx, NEW.attrs,
           COALESCE((
               SELECT json_group_array(ordered.tag)
               FROM (
                   SELECT tag FROM log_tags WHERE log_entry_id = NEW.id ORDER BY tag
               ) ordered
           ), '[]'),
           NEW.status_rx
    FROM workers w
    WHERE w.id = NEW.worker_id;
    UPDATE log_entries SET ambient_event_id = last_insert_rowid() WHERE id = NEW.id;
END;

-- {§client-interactions}: the durable discoverable half of a client-owned
-- interaction. The process-local lifecycle owner holds the awaiting callable;
-- this row holds only presentation and routing facts. Settlement deletes the
-- row, so client response payloads and owner-private continuation state are
-- never copied into persistence.
CREATE TABLE IF NOT EXISTS client_interactions (
    id           INTEGER NOT NULL PRIMARY KEY,
    worker_id    INTEGER NOT NULL,
    loop_id      INTEGER NOT NULL,
    turn_id      INTEGER NOT NULL,
    request      TEXT    NOT NULL CHECK (json_valid(request) AND json_type(request) = 'object'),
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (loop_id)   REFERENCES loops(id)   ON DELETE CASCADE,
    FOREIGN KEY (turn_id)   REFERENCES turns(id)   ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS client_interactions_worker_id_id
    ON client_interactions (worker_id, id);

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
