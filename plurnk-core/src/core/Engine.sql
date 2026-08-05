-- Engine SQL. SPEC {§arch} (architecture), {§scheme} (op dispatch + log).

-- PREP: engine_loop_status
SELECT status FROM loops WHERE id = $loop_id;

-- PREP: engine_worker_has_live_child
-- A non-terminal child worker (worker:// spawn/fork set parent_worker_id) — a "live thing the worker holds",
-- like an open stream. A SEND[200] while one exists is a premature-terminate ({§send-premature-terminate}).
-- Live = a child whose LATEST loop is still pending/running/parked (100/102/202) — the SAME definition
-- engine_child_workers_live uses for the Active Child Workers orientation, so the 409 gate and the section the model
-- reads NEVER disagree: a refused termination is always backed by a child the model can SEE and KILL
-- ({§child-orientation}). An inherited/historical loop (a fork copies the parent's loops) is not the
-- latest, so it never makes a concluded child look forever-live.
SELECT 1 AS live FROM workers r
JOIN loops l ON l.id = (SELECT id FROM loops WHERE worker_id = r.id ORDER BY sequence DESC, id DESC LIMIT 1)
WHERE r.parent_worker_id = $worker_id AND l.status IN (100, 102, 202) LIMIT 1;

-- PREP: engine_count_active_loops_for_worker
-- Wake-on-completion uses this to decide whether to open a new loop or
-- let the existing one pick up the channel transition at the next turn
-- boundary. Status 102 = "in progress" (any non-terminal state).
SELECT COUNT(*) AS n FROM loops WHERE worker_id = $worker_id AND status = 102;

-- PREP: engine_get_loop_flags
-- Raw persisted partial policy. LoopFlagsReader is the sole runtime expansion
-- and validation path ({§loop-flags-effective-read}).
SELECT flags FROM loops WHERE id = $loop_id;

-- PREP: engine_set_loop_flags
-- Updates the loop's persisted flags (json). Called by the runLoop seam.
UPDATE loops SET flags = $flags WHERE id = $loop_id;

-- PREP: engine_tag_loop_attributions
-- {§attribution-discovery-placeholder} — tag the loop with its active plugins' attribution tags
-- (string[] JSON), write-once: the
-- active set is loop-stable, so the `= '[]'` guard keeps later turns from rewriting it.
UPDATE loops SET attributions = $attributions WHERE id = $loop_id AND attributions = '[]';

-- PREP: engine_set_loop_open_paths
-- {§methods-loop-run-open-paths}: persist the initial prompt frame's selected
-- paths (string[] JSON) until turn 1 materializes that frame.
UPDATE loops SET open_paths = $open_paths WHERE id = $loop_id;

-- PREP: engine_get_loop_prompt
-- Initial prompt frame. On turn 1, runTurn stores the owner-keyed
-- prompt:///<loop>/1 entry with its selected paths and publishes it.
SELECT prompt, sequence, open_paths FROM loops WHERE id = $loop_id;

-- PREP: engine_reclaim_queued_loop
-- {§worker-lifecycle-wake-requeue-not-terminal} — atomic 100→102 re-claim by loop id. A wake
-- re-queued this loop while ITS OWN live drain was between turns; the drain re-claims and
-- keeps running (the injected prompt is already the next turn). Conditional so a racing
-- claimant can never double-claim.
UPDATE loops SET status = 102 WHERE id = $loop_id AND status = 100;

-- PREP: workspace_get_settings
-- {§operator-config} — the workspace's validated client settings bag, read at
-- each owning use site with its declared composition semantics.
SELECT settings FROM workspaces WHERE id = $workspace_id;

-- PREP: engine_target_diverged_this_turn
-- #note10 — did this entry diverge on disk THIS turn? A source=file env-delta for the
-- target, materialized into this worker's log at the current turn, means the model's view
-- predates the ambient change — a auto resolution of a same-turn EDIT would clobber it.
SELECT 1 AS hit
FROM log_entries
WHERE worker_id = $worker_id AND turn_id = $turn_id
  AND origin = 'plurnk' AND source = 'file' AND op = 'EDIT'
  AND scheme IS $scheme AND pathname = $pathname
LIMIT 1;

-- PREP: engine_list_owner_entries
-- {§entry-owner} — one principal's entries (catalogRowsFor source for an owner-scoped FIND/foist):
-- the commons, a worker's own space, or a named space — exactly one owner's rows, its perspective.
SELECT e.id AS entry_id, e.scheme, e.pathname, ec.name AS channel, ec.content, ec.mimetype, ec.tokens AS tokens, e.deep_hash,
    s.id AS subscription_id,
    CASE WHEN s.closed_at IS NULL
        THEN CAST(unixepoch('now') - unixepoch(s.opened_at) AS INTEGER)
        ELSE NULL
    END AS seconds,
    s.close_status
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
LEFT JOIN subscriptions s ON s.id = (
    SELECT latest.id
    FROM subscriptions latest
    WHERE latest.entry_id = e.id
    ORDER BY latest.id DESC
    LIMIT 1
)
WHERE e.workspace_id = $workspace_id AND e.owner_id = $owner_id
ORDER BY e.updated_at ASC, e.id ASC, ec.name;

-- PREP: engine_list_owner_entry_tags
-- {§entry-owner} — (entry, tag) for one principal's entries (the owner-scoped catalog's tags field).
SELECT et.entry_id, et.tag
FROM entry_tags et
JOIN entries e ON e.id = et.entry_id
WHERE e.workspace_id = $workspace_id AND e.owner_id = $owner_id
ORDER BY et.entry_id, et.tag;

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_loop_usage
-- Per-loop usage totals and latest-turn gauge ({§tokenomics-client-gauge}),
-- surfaced on {§notifications-loop-terminated}. `context` is the latest
-- provider attempt on the latest turn, distinct from summed billed `prompt`.
SELECT COALESCE(SUM(usage_prompt), 0)     AS prompt,
       COALESCE(SUM(usage_completion), 0) AS completion,
       COALESCE(SUM(usage_cost_usd), 0)  AS cost_usd,
       (
           SELECT a.usage_prompt
           FROM turn_attempts a
           WHERE a.turn_id = (
               SELECT latest.id
               FROM turns latest
               WHERE latest.loop_id = $loop_id
               ORDER BY latest.sequence DESC
               LIMIT 1
           )
           ORDER BY a.sequence DESC
           LIMIT 1
       ) AS context,
       -- Latest turn's effective packet allowance; NULL when uncapped or unknown.
       -- {§tokenomics-client-gauge}
       (SELECT usage_prompt_budget FROM turns WHERE loop_id = $loop_id ORDER BY sequence DESC LIMIT 1) AS context_size,
       -- Latest turn's opaque provider metadata. {§meta-passthrough}
       (SELECT meta FROM turns WHERE loop_id = $loop_id ORDER BY sequence DESC LIMIT 1) AS meta
FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_loop_turn_seqs
-- Look up (loop_seq, turn_seq) for a given (loop_id, turn_id). Used by
-- #writeLog when an op needs to address itself or its output by log
-- coordinate (e.g. EXEC's stream entry at exec:///<loop_seq>/<turn_seq>/<sequence>/EXEC).
SELECT l.sequence AS loop_seq, t.sequence AS turn_seq
FROM loops l, turns t
WHERE l.id = $loop_id AND t.id = $turn_id;

-- PREP: engine_open_turn
-- Turn-as-container model: insert a turn row at runTurn open with no assembled
-- model request and status=102 (in-progress). Pre-model writes
-- (the user prompt; later, system signals/notices) land into
-- this row before the provider is called. The turn is then "closed"
-- via engine_close_turn with the final packet + status + usage stats
-- after dispatch completes.
INSERT INTO turns (loop_id, sequence, status)
VALUES ($loop_id, $sequence, 102)
RETURNING id;

-- PREP: engine_close_turn
-- Updates the turn with the response packet, terminal status, and
-- provider usage stats once dispatch is complete. Paired with
-- engine_open_turn at runTurn boundaries.
UPDATE turns SET
    status = $status,
    packet = $packet,
    usage_prompt = $usage_prompt,
    usage_completion = $usage_completion,
    usage_reasoning = $usage_reasoning,
    usage_cached = $usage_cached,
    usage_cost_usd = $usage_cost_usd,
    usage_prompt_budget = $usage_prompt_budget,
    finish_reason = $finish_reason,
    model = $model,
    meta = $meta
WHERE id = $id;

-- PREP: engine_record_turn_attempt
-- One provider attempt carrying response evidence beneath a turn. Rejected or
-- interrupted attempts remain forensic evidence but never become packet history.
INSERT INTO turn_attempts (
    turn_id,
    sequence,
    accepted,
    response,
    parse_errors,
    usage_prompt,
    usage_completion,
    usage_reasoning,
    usage_cached,
    usage_cost_usd,
    finish_reason,
    model
)
VALUES (
    $turn_id,
    $sequence,
    $accepted,
    $response,
    $parse_errors,
    $usage_prompt,
    $usage_completion,
    $usage_reasoning,
    $usage_cached,
    $usage_cost_usd,
    $finish_reason,
    $model
);

-- PREP: engine_list_workspace_entries
-- Every owner-held entry of a workspace — all schemes, all channels — for
-- internal indexing and aggregate inspection. Addressable catalogs use the
-- owner-filtered statements above.
-- The latest subscription carries stream lifecycle into the catalog. `seconds`
-- is the live age of an open stream; close_status is the exact terminal status
-- of a closed one. Entries with no subscription remain ordinary static entries.
SELECT e.id AS entry_id, e.scheme, e.pathname, ec.name AS channel, ec.content, ec.mimetype, ec.tokens AS tokens, e.deep_hash,
    s.id AS subscription_id,
    CASE WHEN s.closed_at IS NULL
        THEN CAST(unixepoch('now') - unixepoch(s.opened_at) AS INTEGER)
        ELSE NULL
    END AS seconds,
    s.close_status
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
LEFT JOIN subscriptions s ON s.id = (
    SELECT latest.id
    FROM subscriptions latest
    WHERE latest.entry_id = e.id
    ORDER BY latest.id DESC
    LIMIT 1
)
WHERE e.workspace_id = $workspace_id
-- User Note 5 — mtime-ascending: dormant entries hold the stable prompt-cache prefix; churn clusters at the tail.
ORDER BY e.updated_at ASC, e.id ASC, ec.name;

-- PREP: engine_scheme_catalog_summary
-- Per-scheme entry tally plus one-level catalog-row count (direct entries and
-- distinct first-segment `dir/**` summaries). The engine uses the latter to
-- encode a valid first-N file preview range without guessing how many rows the
-- shallow projection will produce.
SELECT e.scheme AS scheme,
    COUNT(DISTINCT e.id) AS entries,
    COUNT(DISTINCT CASE
        WHEN instr(ltrim(e.pathname, '/'), '/') = 0
            THEN 'entry:' || ltrim(e.pathname, '/')
        ELSE 'scope:' || substr(ltrim(e.pathname, '/'), 1, instr(ltrim(e.pathname, '/'), '/'))
    END) AS shallow_items
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.workspace_id = $workspace_id
GROUP BY e.scheme
ORDER BY e.scheme;

-- PREP: engine_initialize_ambient_cursor
-- A worker's first packet reads current shared state directly, so pre-existing
-- occurrences are its baseline rather than historical deltas. The NULL guard
-- makes this safe on every turn and preserves a fork's inherited progress.
UPDATE workers
SET ambient_event_cursor = COALESCE((
    SELECT MAX(ae.id) FROM ambient_events ae WHERE ae.workspace_id = $workspace_id
), 0)
WHERE id = $worker_id
  AND workspace_id = $workspace_id
  AND ambient_event_cursor IS NULL
RETURNING ambient_event_cursor;

-- PREP: engine_pull_ambient_events
-- One SQLite snapshot captures both ends of the closed observation window.
-- The LEFT JOIN returns the boundary even when the window contains no event.
WITH observation AS (
    SELECT w.ambient_event_cursor AS cursor,
           COALESCE(
               (SELECT MAX(ae.id) FROM ambient_events ae WHERE ae.workspace_id = $workspace_id),
               w.ambient_event_cursor,
               0
           ) AS boundary
    FROM workers w
    WHERE w.id = $worker_id AND w.workspace_id = $workspace_id
)
SELECT o.cursor, o.boundary,
       ae.id AS event_id, ae.producer_worker_id, producer.name AS producer_worker_name,
       ae.kind, ae.source,
       ae.op, ae.scheme, ae.hostname, ae.pathname, ae.rx, ae.attrs,
       ae.status_rx, ae.prompt, ae.terminated_by
FROM observation o
LEFT JOIN ambient_events ae
  ON ae.workspace_id = $workspace_id
 AND ae.id > o.cursor
 AND ae.id <= o.boundary
 AND ae.producer_worker_id != $worker_id
LEFT JOIN workers producer ON producer.id = ae.producer_worker_id
ORDER BY ae.id;

-- PREP: engine_insert_ambient_delta
-- Materialize one occurrence into the observer's self-contained log. The
-- targeted conflict rule makes crash replay idempotent without swallowing any
-- unrelated sequence, FK, or shape violation.
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source, ambient_event_id,
    op, scheme, hostname, pathname, tx, mimetype_tx,
    rx, mimetype_rx, status_rx, expanded, attrs
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, 'plurnk', $source, $event_id,
    $op, $scheme, $hostname, $pathname, '', 'text/plain',
    $rx, $mimetype_rx, $status, $expanded, $attrs
)
ON CONFLICT(worker_id, ambient_event_id) WHERE ambient_event_id IS NOT NULL DO NOTHING
RETURNING id;

-- PREP: engine_advance_ambient_cursor
-- Advance only from the snapshot that was actually materialized. A concurrent
-- pull winning the CAS is safe; a loser replays idempotently on its next turn.
UPDATE workers
SET ambient_event_cursor = $boundary
WHERE id = $worker_id
  AND workspace_id = $workspace_id
  AND ambient_event_cursor IS $cursor
  AND $boundary >= ambient_event_cursor
RETURNING ambient_event_cursor;

-- PREP: engine_worker_stream_channels
-- {§exec-stream} — every stream channel the worker owns (an EXEC's stdout/stderr live on the
-- runtime-tag entry), with content + state + coordinate, so the per-turn injector can emit the
-- channel's unshown byte-delta. Stays listed until its last delta is shown (cursor == content len).
SELECT s.id AS subscription_id, e.scheme AS runtime, e.pathname AS coord,
    ec.name AS channel, ec.content AS content, ec.state AS state, s.close_status AS close_status,
    s.close_result AS close_result, s.published_channel AS published_channel
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
JOIN entry_channels ec ON ec.entry_id = s.entry_id
WHERE s.worker_id = $worker_id
  AND (s.published_channel IS NULL OR ec.name = s.published_channel)
ORDER BY s.id, ec.name;

-- PREP: engine_stream_cursor
-- {§exec-stream} — bytes of this channel already shown to the worker: the streamEnd recorded on its
-- latest foisted delta (the caller defaults to 0 when none exists yet).
SELECT attrs
FROM log_entries
WHERE worker_id = $worker_id AND origin = 'plurnk' AND op = 'READ'
    AND scheme = $scheme AND pathname = $pathname AND fragment IS $fragment
ORDER BY id DESC LIMIT 1;

-- PREP: engine_insert_stream_delta
-- {§exec-stream} / {§env-delta} — materialize a channel's unshown byte-delta as a
-- foisted READ row (the model READs the stream it never typed). origin=plurnk; fragment is
-- the channel; attrs.streamEnd is the next turn's cursor; expanded=1 when the channel has CLOSED
-- (the terminal delta auto-OPENs), 0 while it streams (ongoing deltas fold). {§exec-stream}
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source,
    op, scheme, pathname, fragment, tx, mimetype_tx, rx, mimetype_rx, status_rx, attrs, expanded
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, 'plurnk', NULL,
    'READ', $scheme, $pathname, $fragment, '', 'text/plain', $rx, 'application/json', $status, $attrs, $expanded
);

-- PREP: engine_entry_tags
SELECT tag FROM entry_tags WHERE entry_id = $entry_id ORDER BY tag;

-- PREP: engine_child_workers_live
-- The worker's LIVE child workers — latest loop non-terminal (100 pending / 102 processing / 202 parked).
-- Powers the Active Child Workers orienting section ({§child-orientation}): terse `* <status> worker://<name>`
-- pointers so the model SEES what it holds live and reasons for itself (READ/KILL), never told to.
-- Empty → section omitted.
SELECT r.name, l.status
FROM workers r
JOIN loops l ON l.id = (SELECT id FROM loops WHERE worker_id = r.id ORDER BY sequence DESC, id DESC LIMIT 1)
WHERE r.parent_worker_id = $worker_id AND l.status IN (100, 102, 202)
ORDER BY r.name;

-- PREP: engine_child_streams_open
-- The worker's OPEN streams (subscriptions not yet closed) — their addressable coord. Powers the Child
-- Streams orienting section ({§child-orientation}): terse `* active <runtime>:///<coord>` pointers the
-- model OPENs/READs/KILLs. Empty → section omitted.
SELECT s.scheme, e.pathname
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
WHERE s.worker_id = $worker_id AND s.closed_at IS NULL
ORDER BY e.pathname;

-- PREP: engine_render_errors
-- SPEC {§operation-results}: 4xx/5xx log rows are indexed in the packet's errors as
-- LogCoordinate pointers, forcing the model to confront failures instead of letting
-- them rot in log:///. Window = the current turn AND the immediately-prior one
-- (>= current_turn_seq - 1): prior-turn for action failures the model just caused,
-- current-turn so a same-turn engine error (the grinder's budget-overflow row, minted
-- pre-generate then re-derived) surfaces THIS turn rather than a turn late.
-- {§operation-result-uniform-error-channel}
SELECT
    le.op, le.sequence, le.status_rx, le.rx, le.mimetype_rx,
    le.scheme, le.pathname,
    t.sequence AS turn_seq, l.sequence AS loop_seq
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.loop_id = $loop_id
  AND le.status_rx >= 400
  -- {§log-row-self-explains}: every >=400 row points at ITSELF — the op row carries its failure
  -- message on its meta line (packet-wire), so the pointer leads to a record that states its why.
  AND t.sequence >= $current_turn_seq - 1
ORDER BY t.sequence, le.sequence;

-- TX: engine_grinder_fold_newest_turn
-- {§grinder-layer1-rollback} — THE DOCTRINE: the log is the model's memory and the model ALONE
-- curates it (FOLD/KILL). The grinder never touches history — it only blocks NEW memories from
-- landing when there is no room: one set-op folds the still-open rows of the newest turn
-- boundary — the immediately-prior turn's emissions and the current turn's pre-model rows
-- (foists, wake surfaces). Turn 1 is the same rule (no prior turn; its foists are the newest).
-- Folded, never deleted; THREE exemptions ({§grinder-errors-exempt}): op='error',
-- the user prompt, and PLAN. The temporary set captures the
-- selection once so folding and additive `overflow` tagging cannot diverge.
CREATE TEMP TABLE IF NOT EXISTS engine_grinder_fold_set (id INTEGER PRIMARY KEY);
DELETE FROM engine_grinder_fold_set;
INSERT INTO engine_grinder_fold_set (id)
SELECT id FROM log_entries
WHERE loop_id = $loop_id AND expanded = 1 AND op NOT IN ('error', 'PLAN')
  AND COALESCE(scheme, '') != 'prompt'  -- the task frame ({§prompt-self-only}); NULL-safe: a model row's scheme is NULL
  AND (turn_id = $turn_id
       OR turn_id = (SELECT MAX(id) FROM turns WHERE loop_id = $loop_id AND id < $turn_id));

UPDATE log_entries SET expanded = 0
WHERE id IN (SELECT id FROM engine_grinder_fold_set);

INSERT OR IGNORE INTO log_tags (log_entry_id, tag)
SELECT id, 'overflow' FROM engine_grinder_fold_set;

DELETE FROM engine_grinder_fold_set;

-- PREP: engine_fold_log_entry
-- Fold one known log row by id. Model mirror rows use this after insertion so
-- the complete admitted emission remains available without opening by default.
UPDATE log_entries SET expanded = 0 WHERE id = $id;

-- PREP: engine_render_log
-- Render-time log-section assembly ({§body-projection}).
-- Yields log_entries for the whole worker — the conversation's working
-- memory carries across loops within a worker, not just the
-- current loop. Coordinate is log:///<loop_seq>/<turn_seq>/<sequence>/<op>.
-- Status 202 entries in state='proposed' are model-invisible until resolved.
-- `expanded = 0` rows are FOLDED — listed but collapsed to their coordinate
-- (FOLD); the renderer elides the body. {§open-fold}: folded rows stay listed, re-OPENable.
SELECT
    l.sequence  AS loop_seq,
    t.sequence  AS turn_seq,
    le.sequence,
    -- le.origin is attribution, never a render filter; the worker's actor — {§actor-boundary-origin-not-filter} {§machine-processes-worker-origin}
    le.origin,
    le.op, le.suffix, le.signal,
    le.scheme, le.username, le.password,
    le.hostname, le.port, le.pathname,
    le.query, le.fragment,
    le.status_rx, le.rx, le.mimetype_rx,
    le.tx, le.mimetype_tx,
    le.state, le.outcome, le.expanded, le.source, le.attrs
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
-- WHERE renders exactly one worker's log — {§actor-boundary-isolation} {§machine-processes-worker-is-its-log}
-- the AND NOT clauses keep proposed (202) rows hidden until resolved ({§proposal-proposed-hidden}),
-- and successful log-curation receipts out of the packet. OPEN/FOLD follow
-- {§fold-open-meta-operations}; only log-target KILL follows
-- {§kill-log-receipt-suppressed}. Every failed operation remains visible through
-- {§operation-result-uniform-error-channel}.
WHERE le.worker_id = $worker_id
  AND NOT (le.status_rx = 202 AND le.state = 'proposed')
  AND NOT (le.op IN ('OPEN', 'FOLD') AND le.status_rx < 400)
  AND NOT (le.op = 'KILL' AND le.scheme = 'log' AND le.status_rx < 400)
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: engine_insert_log_entry
-- Default state='resolved' covers the common path (non-proposing schemes
-- return their final status immediately). Status 202 + state='proposed'
-- triggers the proposal lifecycle (engine pauses dispatch; client resolves
-- via proposal resolution; entry transitions through engine_resolve_log_entry).
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source,
    op, suffix, signal,
    scheme, username, password, hostname, port,
    pathname, query, fragment, lineMarker,
    tx, mimetype_tx, rx, mimetype_rx, status_rx, tokens,
    state, outcome, attrs
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, $origin, $source,
    $op, $suffix, $signal,
    $scheme, $username, $password, $hostname, $port,
    $pathname, $query, $fragment, $lineMarker,
    $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $tokens,
    $state, $outcome, $attrs
)
RETURNING id;

-- PREP: engine_resolve_log_entry
-- Transitions a proposed log entry to its terminal state. Used by the
-- proposal lifecycle (client resolution, auto resolution, timeout, abort).
-- Updates status_rx + rx + state + outcome atomically.
UPDATE log_entries
   SET state = $state,
       outcome = $outcome,
       status_rx = $status_rx,
       rx = $rx,
       deep_hash = NULL
 WHERE id = $id
   AND state = 'proposed';

-- PREP: engine_log_entry_coordinate
-- Resolve a durable operation occurrence after a proposal settles so a
-- Problem Details instance names the same model-facing log URI as every
-- immediately failed operation.
SELECT l.sequence AS loop_seq,
       t.sequence AS turn_seq,
       le.sequence AS sequence,
       le.op AS op
  FROM log_entries le
  JOIN turns t ON t.id = le.turn_id
  JOIN loops l ON l.id = le.loop_id
 WHERE le.id = $id;

-- PREP: engine_turn_retrievals
-- {§send-premature-terminate} — the pending set's retrieval leg: THIS turn's READ/FIND/OPEN rows,
-- whose results the model cannot have seen (they fold back next packet). A [200] over them is
-- discarding answers it asked for.
SELECT id FROM log_entries
WHERE turn_id = $turn_id AND origin = 'model' AND op IN ('READ', 'FIND', 'OPEN');

-- PREP: engine_worker_has_undelivered_stream_term
-- A stream may finish between its EXEC and a same-turn SEND. It is then no longer
-- live, but its terminal outcome has not crossed the pre-turn observation boundary:
-- no foisted terminal READ exists yet. Treat that closed result like a same-turn
-- retrieval or child termination so an empty join cannot conclude over unseen work.
-- Completion is information independently of payload: an empty success and especially
-- an empty failure must receive the same terminal observation as a non-empty stream.
SELECT 1 AS pending
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
WHERE s.worker_id = $worker_id
  AND s.closed_at IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM log_entries le
      WHERE le.worker_id = $worker_id
        AND le.origin = 'plurnk'
        AND le.op = 'READ'
        AND le.scheme = e.scheme
        AND le.pathname = e.pathname
        AND json_extract(le.attrs, '$.terminal') = 1
  )
LIMIT 1;

-- PREP: engine_turn_failures
-- {§send-premature-terminate} — THIS turn's failed op results (the model's own ops, status >= 400), whose
-- errors the model cannot have seen (they land next packet). A [200] or already-drained [202] over
-- them concludes blind past a failure — refused 409; [499] abandons regardless (declaring failure
-- IS weighing it).
-- Actionless engine errors are excluded: the grinder's overflow row mints pre-packet, so the
-- recovery turn already saw it ({§grinder-hard-413-recovery}). A model-authored statement that
-- failed grammar parsing is different: source='grammar' records a bounded operation failure
-- from the accepted emission, unseen until the next packet, so it gates completion like every
-- other failed model operation.
SELECT id FROM log_entries
WHERE turn_id = $turn_id
  AND origin = 'model'
  AND status_rx >= 400
  AND (op != 'error' OR source = 'grammar');

-- PREP: engine_reconcile_turn_status
-- A SEND's signal is only provisional until dispatch adjudicates live obligations and failures.
-- The close writes packet+usage before ops dispatch, so reconcile the persisted turn whenever
-- dispatch changes that disposition (for example refused 200 -> 102 or drained 202 -> 200).
UPDATE turns SET status = $status WHERE id = $id;



-- PREP: engine_loop_sequence
-- The loop's per-worker sequence — the model-facing coordinate (prompt/<worker>/<loop-seq>/<turn-seq>,
-- matching the log's loop-relative numbering). The raw db id leaked into prompt paths and the
-- model's first loop read as prompt/2/1 (the docs loop holds id 1). Owner: minor but annoying.
SELECT sequence FROM loops WHERE id = $loop_id;

-- PREP: engine_worker_lineage_root
-- The no-parent root of a worker lineage; a root worker returns itself.
-- {§worker-primary}
WITH RECURSIVE lineage(id, parent_worker_id) AS (
    SELECT id, parent_worker_id FROM workers WHERE id = $worker_id
    UNION ALL
    SELECT w.id, w.parent_worker_id FROM workers w JOIN lineage l ON w.id = l.parent_worker_id
)
SELECT id FROM lineage WHERE parent_worker_id IS NULL;

-- PREP: engine_worker_has_undelivered_child_term
-- A child conclusion newer than the parent's observation cursor is complete but
-- not delivered. This is the same durable boundary the next packet consumes,
-- not a second timestamp race. {§send-undelivered-child-term}
SELECT 1 AS pending
FROM ambient_events ae
JOIN workers child ON child.id = ae.producer_worker_id
JOIN workers parent ON parent.id = $worker_id
WHERE ae.workspace_id = parent.workspace_id
  AND ae.kind = 'loop_termination'
  AND child.parent_worker_id = parent.id
  AND ae.id > COALESCE(parent.ambient_event_cursor, 0)
LIMIT 1;
