-- MIGRATE: 6 log
-- Chapter 6 of the schema baseline ({§db-schema-baseline}): The log: rows, their projections, curation effects, and the views the packet reads.
-- Version numbers order the chapters on a fresh database; they are not history. A shape
-- change edits the chapter in place; existing development databases are recreated.

-- log_entries
-- Chronological event store. sequence is 1-based, scoped to the turn —
-- resets at each new turn. URI-bit columns are unprefixed (scheme,
-- pathname, …). state/outcome/attrs carry the proposal lifecycle —
-- status⊥state: status is the HTTP outcome, state is where in the
-- lifecycle the entry sits. Most rows write 'resolved' directly;
-- proposing schemes transition 'proposed' → resolved/failed/cancelled.
-- initial_folded is the immutable visibility with which the event entered the
-- log. Current model-facing membership and folded intervals belong to
-- log_entry_projections below; curation never rewrites or removes this event.
CREATE TABLE IF NOT EXISTS log_entries (
    id              INTEGER NOT NULL PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),

    worker_id          INTEGER NOT NULL,
    loop_id         INTEGER NOT NULL,
    turn_id         INTEGER NOT NULL,
    sequence        INTEGER NOT NULL           CHECK (sequence >= 1),
    at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    origin          TEXT    NOT NULL           CHECK (origin IN ('model', 'client', '_plurnk', 'plugin')),
    -- {§env-delta-attribution}: a causal worker:// identity, log:/// operation
    -- address, or stable subsystem token ('file'); NULL = the owning worker
    -- itself, rendered without causal attribution.
    source          TEXT,
    -- Engine-owned occurrence identity. Source rows are stamped NULL→id by the
    -- journal trigger; observer and fork copies carry it at insertion.
    ambient_event_id INTEGER                  REFERENCES ambient_events(id),
    -- Fork history is copied evidence, never new activity. Rows with no source
    -- occurrence still need this structural guard against republication.
    inherited_history INTEGER NOT NULL DEFAULT 0 CHECK (inherited_history IN (0, 1)),
    -- Search derivation attached to this durable log result, when available.
    deep_hash       TEXT                       REFERENCES derivations(deep_hash),
    -- Exact logical provider call represented by a BARE result or rejected
    -- emissionAttempt. Other operation and ambient
    -- rows carry no model-call identity.
    model_call_id   INTEGER                    REFERENCES model_calls(id),
    -- Engine-owned stream publication that produced this observation. The
    -- publication cursor survives log curation; this relation is evidence,
    -- never the acknowledgement itself. {§exec-stream}
    subscription_publication_id INTEGER        REFERENCES subscription_publications(id) ON DELETE SET NULL,

    -- 'error' is an ACTIONLESS row ({§operation-results} — errors are log items): a parse failure that
    -- produced no op still records a log entry (op='error', status_rx≥400, no target) so the model
    -- can fold/kill/recall its own mistakes like any other log row — one budget surface, the log.
    -- Rejected-attempt artifacts carry NULL here ({§rejected-emission-entry}).
    -- No op enum here: the grammar op set is grammar's contract (PlurnkOp), and this column is written
    -- only by the PlurnkOp-typed engine (grammar ops), service row selectors, or NULL for no op.
    -- A SQL enum would be a hand-copy of grammar's op list that silently goes stale on every new verb
    -- (it did — FORK/WORK). Validity lives at the parse + type layer, not duplicated in DDL.
    op              TEXT,
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
    native_content_hash TEXT GENERATED ALWAYS AS (
        CASE WHEN mimetype_rx = 'application/json' AND json_valid(rx)
        THEN json_extract(rx, '$.nativeContentHash') END
    ) VIRTUAL REFERENCES native_contents(hash),

    -- Complete canonical LogBody content before coordinate/presentation
    -- projection; persistence envelopes do not contribute. {§tokenomics-weight-stored-at-write}
    weight          INTEGER NOT NULL DEFAULT 0 CHECK (weight >= 0),

    state           TEXT    NOT NULL DEFAULT 'resolved'
                    CHECK (state IN ('proposed', 'resolved', 'failed', 'cancelled')),
    outcome         TEXT,
    attrs           TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),

    initial_folded   TEXT    NOT NULL DEFAULT '[]'
                    CHECK (json_valid(initial_folded) AND json_type(initial_folded) = 'array'),

    CHECK (
        (op IS NULL) = COALESCE(
            json_extract(attrs, '$.kind') = 'emissionAttempt',
            0
        )
    ),
    CHECK (json_extract(attrs, '$.kind') != 'emissionAttempt' OR origin = 'model'),

    FOREIGN KEY (worker_id)  REFERENCES workers(id)  ON DELETE CASCADE,
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS log_entries_turn_id_sequence ON log_entries (turn_id, sequence);

CREATE        INDEX IF NOT EXISTS log_entries_worker_id           ON log_entries (worker_id);

CREATE        INDEX IF NOT EXISTS log_entries_loop_id          ON log_entries (loop_id);

-- {§db-fk-indexes} Derivation replacement checks the rows that cite the hash.
CREATE        INDEX IF NOT EXISTS log_entries_deep_hash        ON log_entries (deep_hash) WHERE deep_hash IS NOT NULL;

-- {§loop-response-messages}: executed messages survive curation. This projection
-- is also used inside atomic cancellation; no second response accumulator exists.
CREATE VIEW IF NOT EXISTS loop_responses AS
SELECT le.loop_id,
    group_concat(json_extract(le.tx, '$.body.raw'), char(10) || char(10)
        ORDER BY t.sequence, le.sequence) AS content
FROM log_entries le JOIN turns t ON t.id = le.turn_id
WHERE le.op = 'SEND' AND le.state = 'resolved' AND le.status_rx BETWEEN 200 AND 299
  AND le.source IS NULL AND le.inherited_history = 0
  AND json_valid(le.tx)
  -- {§send-prompt-acceptance}: a SEND to one of this loop's own prompts is the response too;
  -- the dispatcher admits only own-loop prompt addresses, so the scheme alone identifies them.
  AND (json_type(le.tx, '$.target') = 'null' OR json_extract(le.tx, '$.target.scheme') = 'prompt')
  AND json_type(le.tx, '$.body.raw') = 'text'
  AND length(json_extract(le.tx, '$.body.raw')) > 0
GROUP BY le.loop_id;

CREATE UNIQUE INDEX IF NOT EXISTS log_entries_model_call_id
    ON log_entries (model_call_id)
    WHERE model_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS log_entries_subscription_publication_id
    ON log_entries (subscription_publication_id)
    WHERE subscription_publication_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS log_entries_worker_ambient_event
    ON log_entries (worker_id, ambient_event_id)
    WHERE ambient_event_id IS NOT NULL;

-- {§log-history-projection} — log_entries is append-only execution evidence;
-- this one-to-one row is the current model-facing projection of that evidence.
-- KILL is a terminal active→inactive transition. Scoped KILL mutates only folded
-- intervals while active. The initial state is created in the same statement as
-- its event so no durable row can exist without one projection state.
CREATE TABLE IF NOT EXISTS log_entry_projections (
    log_entry_id INTEGER NOT NULL PRIMARY KEY,
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    folded       TEXT    NOT NULL DEFAULT '[]'
                         CHECK (json_valid(folded) AND json_type(folded) = 'array'),
    output_admission_turn_id INTEGER,
    output_withheld INTEGER NOT NULL DEFAULT 0 CHECK (output_withheld IN (0, 1)),
    CHECK (output_withheld = 0 OR output_admission_turn_id IS NOT NULL),
    FOREIGN KEY (output_admission_turn_id) REFERENCES turns(id),
    FOREIGN KEY (log_entry_id) REFERENCES log_entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- {§db-fk-indexes} Opening a turn checks admissions that cite a turn; without this every projection row is read.
CREATE INDEX IF NOT EXISTS log_entry_projections_output_admission_turn ON log_entry_projections (output_admission_turn_id) WHERE output_admission_turn_id IS NOT NULL;

-- {§context-output-selection} Admission is a durable projection decision, not
-- deletion or proof of provider delivery. It cannot be reset to replay output.
CREATE TRIGGER IF NOT EXISTS log_output_admission_immutable
BEFORE UPDATE OF output_admission_turn_id, output_withheld ON log_entry_projections
WHEN OLD.output_admission_turn_id IS NOT NULL AND (
    NEW.output_admission_turn_id IS NOT OLD.output_admission_turn_id
    OR NEW.output_withheld != OLD.output_withheld
)
BEGIN
    SELECT RAISE(ABORT, 'log output admission is immutable');
END;

CREATE TRIGGER IF NOT EXISTS log_output_admission_owner
BEFORE UPDATE OF output_admission_turn_id ON log_entry_projections
WHEN NEW.output_admission_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM turns turn
    JOIN loops loop ON loop.id = turn.loop_id
    JOIN log_entries entry ON entry.worker_id = loop.worker_id
    WHERE turn.id = NEW.output_admission_turn_id AND entry.id = NEW.log_entry_id
)
BEGIN
    SELECT RAISE(ABORT, 'log output admission must belong to its worker');
END;

-- The ordinary operation surface reads this view. Forensic and lifecycle
-- machinery names log_entries directly and therefore retains complete history.
CREATE VIEW IF NOT EXISTS active_log_entries AS
SELECT le.id, le.version, le.worker_id, le.loop_id, le.turn_id, le.sequence,
       le.at, le.origin, le.source, le.ambient_event_id, le.inherited_history,
       le.deep_hash, le.model_call_id, le.subscription_publication_id,
       le.op, le.signal, le.scheme, le.username, le.password,
       le.hostname, le.port, le.pathname, le.query, le.fragment, le.lineMarker,
       le.tx, le.mimetype_tx,
       le.rx, le.mimetype_rx, le.status_rx, le.weight,
       le.state, le.outcome, le.attrs, le.initial_folded, projection.folded,
       projection.output_admission_turn_id, projection.output_withheld
FROM log_entries le
JOIN log_entry_projections projection ON projection.log_entry_id = le.id
WHERE projection.active = 1;

-- Individual execution events are append-only. Containing-history teardown is
-- the one removal owner: a cascading delete has already removed at least one
-- ancestor in the workspace→worker→loop→turn chain. A direct row delete while
-- that complete owner chain remains would fabricate chronology and is rejected.
CREATE TRIGGER IF NOT EXISTS log_entries_delete_with_owner_only
BEFORE DELETE ON log_entries
WHEN EXISTS (
    SELECT 1
    FROM turns
    JOIN loops ON loops.id = turns.loop_id
    JOIN workers ON workers.id = loops.worker_id
    JOIN workspaces ON workspaces.id = workers.workspace_id
    WHERE turns.id = OLD.turn_id
)
BEGIN
    SELECT RAISE(ABORT, 'log entries can only be removed with their containing history');
END;

-- A log row belongs to one exact worker/loop/turn chain. Its writer is either
-- that turn's producer or `_plurnk` observing the turn. Primitive absence,
-- enum, and foreign-key failures remain owned by their column constraints.
CREATE TRIGGER IF NOT EXISTS log_entries_turn_ownership
BEFORE INSERT ON log_entries
WHEN NEW.worker_id IS NOT NULL
 AND NEW.loop_id IS NOT NULL
 AND NEW.turn_id IS NOT NULL
 AND NEW.origin IN ('model', 'client', '_plurnk', 'plugin')
 AND EXISTS (SELECT 1 FROM workers WHERE id = NEW.worker_id)
 AND EXISTS (SELECT 1 FROM loops WHERE id = NEW.loop_id)
 AND EXISTS (SELECT 1 FROM turns WHERE id = NEW.turn_id)
 AND NOT EXISTS (
    SELECT 1
    FROM turns
    JOIN loops ON loops.id = turns.loop_id
    WHERE turns.id = NEW.turn_id
      AND loops.id = NEW.loop_id
      AND loops.worker_id = NEW.worker_id
      AND (NEW.origin = turns.producer OR NEW.origin = '_plurnk')
)
BEGIN
    SELECT RAISE(ABORT, 'log entry must match its turn ownership and producer');
END;

-- A folded interval is an inclusive [start,end] pair. Ranges are positive,
-- sorted, disjoint, and non-adjacent; -1 is the final open-ended endpoint.
-- Canonical intervals make visibility equality and curation effects exact.
CREATE TRIGGER IF NOT EXISTS log_entry_projections_folded_valid_insert
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

CREATE TRIGGER IF NOT EXISTS log_entry_projections_folded_valid_update
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

CREATE TRIGGER IF NOT EXISTS log_entry_projections_kill_terminal
BEFORE UPDATE OF active ON log_entry_projections
WHEN OLD.active = 0 AND NEW.active != 0
BEGIN
    SELECT RAISE(ABORT, 'a killed log entry cannot re-enter the active projection');
END;

CREATE TRIGGER IF NOT EXISTS log_entry_projections_delete_with_event_only
BEFORE DELETE ON log_entry_projections
WHEN EXISTS (SELECT 1 FROM log_entries WHERE id = OLD.log_entry_id)
BEGIN
    SELECT RAISE(ABORT, 'a durable log event must retain its projection');
END;

CREATE TRIGGER IF NOT EXISTS log_entries_model_call_valid
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
          (inference.kind = 'bare' AND NEW.op = 'BARE')
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

-- Successful log-KILL rows are durable curation events even though
-- their ordinary packet projection is suppressed. Preserve the exact selected
-- set and each target's before/after projection so a broad selector never
-- collapses into the lossy fact `matched: N`.
CREATE TABLE IF NOT EXISTS log_curation_effects (
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
    FOREIGN KEY (operation_log_entry_id) REFERENCES log_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (target_log_entry_id)    REFERENCES log_entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS log_curation_effects_target
    ON log_curation_effects (target_log_entry_id);

-- Curation effects are append-only execution evidence. They may disappear
-- only when either referenced event is already being removed with its
-- containing history; direct mutation while both events survive is forbidden.
CREATE TRIGGER IF NOT EXISTS log_curation_effects_immutable
BEFORE UPDATE ON log_curation_effects
BEGIN
    SELECT RAISE(ABORT, 'log curation effects are immutable execution evidence');
END;

CREATE TRIGGER IF NOT EXISTS log_curation_effects_delete_with_history_only
BEFORE DELETE ON log_curation_effects
WHEN EXISTS (
    SELECT 1 FROM log_entries WHERE id = OLD.operation_log_entry_id
)
AND EXISTS (
    SELECT 1 FROM log_entries WHERE id = OLD.target_log_entry_id
)
BEGIN
    SELECT RAISE(ABORT, 'log curation effects can only be removed with their containing history');
END;

-- Make an invalid curation record structurally unavailable: the event must be
-- one successful log-KILL row, both rows must belong to the same
-- worker, and its state transition must match that op.
CREATE TRIGGER IF NOT EXISTS log_curation_effects_valid
BEFORE INSERT ON log_curation_effects
BEGIN
    SELECT CASE WHEN
        NOT EXISTS (
            SELECT 1
            FROM log_entries operation
            JOIN log_entries target ON target.id = NEW.target_log_entry_id
            WHERE operation.id = NEW.operation_log_entry_id
              AND operation.op = 'KILL'
              AND operation.status_rx < 400
              AND operation.worker_id = target.worker_id
        )
        OR NOT EXISTS (
            -- {§log-kill-scope} — a scoped KILL keeps the row active and changes its visibility;
            -- a whole KILL retires it with its visibility untouched.
            SELECT 1
            FROM log_entries operation
            WHERE operation.id = NEW.operation_log_entry_id
              AND operation.op = 'KILL'
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

-- The dispatcher binds an exact, transient curation plan into attrs on the
-- successful log-KILL row. No other row may carry that payload.
CREATE TRIGGER IF NOT EXISTS log_entries_curation_payload_valid
BEFORE INSERT ON log_entries
WHEN json_type(NEW.attrs, '$.__plurnk_curation') IS NOT NULL
 AND NOT (
    NEW.op = 'KILL'
    AND NEW.status_rx < 400
    AND NEW.scheme = 'log'
    AND json_type(NEW.attrs, '$.__plurnk_curation') = 'object'
 )
BEGIN
    SELECT RAISE(ABORT, 'private log curation payload requires a successful log curation row');
END;

-- Column-scoped immutability: the original action's identity, target, and
-- initial projection never change. Proposal lifecycle may mutate its outcome;
-- curation state lives outside the event row. Keep attrs separate so the
-- curation trigger's private-payload removal cannot exempt other columns.
CREATE TRIGGER IF NOT EXISTS log_entries_immutable_core
BEFORE UPDATE OF
    worker_id, loop_id, turn_id, sequence, at, origin, source, inherited_history, model_call_id,
    op, signal,
    scheme, username, password, hostname,
    port, pathname, query, fragment,
    lineMarker, tx, mimetype_tx, mimetype_rx, initial_folded
ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only lifecycle outcome and derived attachments may change');
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

-- One relational projection owns activity eligibility, audience, and snapshot
-- shape for both immediately-final and proposal-settlement paths.
CREATE VIEW IF NOT EXISTS ambient_activity_candidates AS
SELECT *
FROM (
    SELECT w.workspace_id,
           le.worker_id AS producer_worker_id,
           -- {§env-delta-child-activity} — the runtime's own materialization (turn-0
           -- initialization, doc-reconciliation maintenance, operation batches) is
           -- private to the worker it serves and never crosses to the parent.
           CASE
               WHEN t.producer = '_plurnk' AND t.kind IN ('operation', 'initialization', 'maintenance') THEN NULL
               ELSE w.parent_worker_id
           END AS target_parent_worker_id,
           CASE
               WHEN le.state = 'resolved'
                AND NOT (t.producer = '_plurnk' AND t.kind = 'maintenance')
                AND le.status_rx BETWEEN 200 AND 399
                AND le.status_rx != 304
                AND (
                    (
                        le.op IN ('EDIT', 'KILL')
                        AND le.scheme = 'worker'
                        AND le.hostname IS NULL
                        AND le.pathname IS NOT NULL
                    )
                    OR (
                        le.op IN ('COPY', 'MOVE')
                        AND json_valid(le.rx)
                        AND EXISTS (
                            SELECT 1 FROM json_each(le.rx, '$.effects') effect
                            WHERE json_type(effect.value) = 'object'
                              AND substr(CAST(json_extract(effect.value, '$.target') AS TEXT), 1, 10) = 'worker:///'
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
    JOIN workers w ON w.id = le.worker_id
    JOIN loops l ON l.id = le.loop_id
    JOIN turns t ON t.id = le.turn_id
    WHERE le.ambient_event_id IS NULL
      AND le.inherited_history = 0
      AND le.op IS NOT NULL
      AND le.state != 'proposed'
      AND NOT (
          le.op IN ('NEXT', 'WAIT', 'DONE', 'FAIL')
          AND l.status IN (200, 413, 429, 499, 500, 504, 508)
      )
) candidate
WHERE target_parent_worker_id IS NOT NULL OR workspace_broadcast = 1;
