-- Engine SQL. SPEC {§arch} (architecture), {§scheme} (op dispatch + log).

-- PREP: engine_loop_status
SELECT status FROM loops WHERE id = $loop_id;

-- PREP: engine_worker_has_live_child
-- A non-terminal child worker (worker:// spawn/fork set parent_worker_id) — a "live thing the worker holds",
-- like an open stream. A SEND signal 200 while one exists is a premature-terminate ({§send-premature-terminate}).
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

-- PREP: engine_set_loop_open_paths
-- {§methods-loop-run-open-paths}: persist the initial prompt frame's selected
-- paths (string[] JSON) until turn 1 materializes that frame.
UPDATE loops SET open_paths = $open_paths WHERE id = $loop_id;

-- PREP: engine_get_loop_prompt
-- Initial prompt frame. Its durable log occurrence, not a process-local/model
-- ordinal, decides whether runTurn still needs to publish it.
SELECT l.prompt, l.sequence, l.open_paths,
       EXISTS (
           SELECT 1
           FROM log_entries le
           WHERE le.loop_id = l.id
             AND le.op = 'prompt'
             AND le.pathname = '/' || l.sequence || '/1'
       ) AS prompt_published
FROM loops l
WHERE l.id = $loop_id;

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
  AND origin = '_plurnk' AND source = 'file' AND op = 'EDIT'
  AND scheme IS $scheme AND pathname = $pathname
LIMIT 1;

-- PREP: engine_list_owner_entries
-- {§entry-owner} — one principal's entries (catalogRowsFor source for an owner-scoped FIND/foist):
-- the commons, a worker's own space, or a named space — exactly one owner's rows, its perspective.
SELECT e.id AS entry_id, e.scheme, e.pathname, ec.name AS channel, ec.content, ec.mimetype, ec.weight AS weight, ec.deep_hash,
    d.parse_issues, d.summary,
    s.id AS subscription_id,
    CASE WHEN s.closed_at IS NULL
        THEN CAST(unixepoch('now') - unixepoch(s.opened_at) AS INTEGER)
        ELSE NULL
    END AS seconds,
    s.close_status
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
LEFT JOIN derivations d ON d.deep_hash = ec.deep_hash
LEFT JOIN subscriptions s ON s.id = (
    SELECT latest.id
    FROM subscriptions latest
    WHERE latest.entry_id = e.id
    ORDER BY latest.id DESC
    LIMIT 1
)
WHERE e.workspace_id = $workspace_id AND e.owner_id = $owner_id
ORDER BY e.updated_at ASC, e.id ASC, ec.name;

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_loop_usage
-- Latest packet-bearing model-turn gauge ({§tokenomics-client-gauge}), surfaced beside the derived
-- accounting projection on {§notifications-loop-terminated}. Physical usage
-- and capacity bind to the same latest completed emission call. A preflight
-- rejection has capacity evidence but no physical input usage; neither fact
-- falls back to an earlier call. Packetless chronology cannot erase the latest
-- assembled model request.
WITH latest_turn AS (
    SELECT id, packet, usage_curation_budget, meta
      FROM turns
     WHERE loop_id = $loop_id AND packet IS NOT NULL
     ORDER BY sequence DESC
     LIMIT 1
), latest_emission AS (
    SELECT mc.id, mc.capacity
      FROM model_calls mc
      JOIN latest_turn turn ON turn.id = mc.turn_id
     WHERE mc.kind = 'emission' AND mc.state != 'pending'
     ORDER BY mc.sequence DESC
     LIMIT 1
)
SELECT (
           SELECT pr.usage_input
             FROM provider_requests pr
            WHERE pr.model_call_id = (SELECT id FROM latest_emission)
              AND pr.state = 'settled'
            ORDER BY pr.sequence DESC
            LIMIT 1
       ) AS context_tokens,
       (SELECT json_extract(packet, '$.weight') FROM latest_turn) AS curation_weight,
       (SELECT usage_curation_budget FROM latest_turn) AS curation_budget,
       (SELECT json_extract(capacity, '$.inputCapacity') FROM latest_emission) AS context_capacity,
       -- Latest turn's opaque provider metadata. {§meta-passthrough}
       (SELECT meta FROM latest_turn) AS meta
FROM loops
WHERE id = $loop_id;

-- PREP: engine_loop_provider_requests
-- Ordered cardinal accounting evidence. Aggregation belongs to the shared
-- provider accounting contract, not SQLite arithmetic or denormalized rows.
SELECT pr.provider, pr.model, pr.outcome, pr.status,
       pr.usage_input, pr.usage_output, pr.usage_total,
       pr.usage_input_no_cache, pr.usage_input_cache_read, pr.usage_input_cache_write,
       pr.usage_output_text, pr.usage_output_reasoning,
       pr.cost_kind, pr.cost_amount, pr.cost_currency, pr.cost_usd_equivalent,
       pr.cost_source, pr.cost_reason
FROM provider_requests pr
JOIN model_calls mc ON mc.id = pr.model_call_id
JOIN turns t ON t.id = mc.turn_id
WHERE t.loop_id = $loop_id AND pr.state = 'settled'
ORDER BY t.sequence, mc.sequence, pr.sequence;

-- PREP: engine_loop_attributions
-- {§attribution} — derive the loop projection from exact response-attempt
-- evidence plus each turn's latest request (which also covers a call that
-- failed without response evidence).
SELECT attribution
FROM (
    SELECT value AS attribution
    FROM turns t, json_each(t.packet, '$.attributions')
    WHERE t.loop_id = $loop_id
    UNION
    SELECT value AS attribution
    FROM model_calls mc
    JOIN turns t ON t.id = mc.turn_id,
         json_each(mc.attributions)
    WHERE t.loop_id = $loop_id
)
ORDER BY attribution;

-- PREP: engine_loop_turn_seqs
-- Look up (loop_seq, turn_seq) for a given (loop_id, turn_id). Used by
-- #writeLog when an op needs to address itself or its output by log
-- coordinate (e.g. EXEC's stream entry at exec:///<loop_seq>/<turn_seq>/<sequence>/EXEC).
SELECT l.sequence AS loop_seq, t.sequence AS turn_seq
FROM loops l, turns t
WHERE l.id = $loop_id AND t.id = $turn_id;

-- PREP: engine_open_model_call
-- Logical identity and request attribution become durable before provider I/O.
INSERT INTO model_calls (turn_id, sequence, kind, attributions, model)
VALUES ($turn_id, $sequence, $kind, $attributions, $model)
RETURNING id;

-- PREP: engine_observe_model_call_response
-- Preserve the logical response before call-specific interpretation. Physical
-- request accounting has already settled through its cardinal observer path.
UPDATE model_calls SET
    state = 'response',
    response = $response,
    failure = $failure,
    capacity = $capacity,
    finish_reason = $finish_reason,
    model = $model,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = $id AND state = 'pending';

-- PREP: engine_fail_model_call
UPDATE model_calls SET
    state = 'error',
    failure = $failure,
    capacity = $capacity,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = $id AND state = 'pending';

-- PREP: engine_open_turn_attempt
INSERT INTO turn_attempts (model_call_id)
VALUES ($model_call_id)
RETURNING id;

-- PREP: engine_classify_turn_attempt_response
UPDATE turn_attempts SET
    accepted = $accepted,
    parse_errors = $parse_errors
WHERE id = $id AND accepted IS NULL;

-- PREP: engine_open_provider_request
-- The provider calls this immediately before physical I/O.
INSERT INTO provider_requests (model_call_id, sequence, provider, model)
VALUES ($model_call_id, $sequence, $provider, $model)
RETURNING id;

-- PREP: engine_settle_provider_request
UPDATE provider_requests SET
    state = 'settled',
    outcome = $outcome,
    status = $status,
    usage_input = $usage_input,
    usage_output = $usage_output,
    usage_total = $usage_total,
    usage_input_no_cache = $usage_input_no_cache,
    usage_input_cache_read = $usage_input_cache_read,
    usage_input_cache_write = $usage_input_cache_write,
    usage_output_text = $usage_output_text,
    usage_output_reasoning = $usage_output_reasoning,
    cost_kind = $cost_kind,
    cost_amount = $cost_amount,
    cost_currency = $cost_currency,
    cost_usd_equivalent = $cost_usd_equivalent,
    cost_source = $cost_source,
    cost_reason = $cost_reason,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = $id AND state = 'pending';

-- PREP: engine_list_workspace_entries
-- Every owner-held entry of a workspace — all schemes, all channels — for
-- internal indexing and aggregate inspection. Addressable catalogs use the
-- owner-filtered statements above.
-- The latest subscription carries stream lifecycle into the catalog. `seconds`
-- is the live age of an open stream; close_status is the exact terminal status
-- of a closed one. Entries with no subscription remain ordinary static entries.
SELECT e.id AS entry_id, e.scheme, e.pathname, ec.name AS channel, ec.content, ec.mimetype, ec.weight AS weight, ec.deep_hash,
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
       ae.op, ae.scheme, ae.hostname, ae.pathname, ae.rx, ae.attrs, ae.tags,
       ae.status_rx, ae.terminated_by
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
    rx, mimetype_rx, status_rx, weight, folded, attrs
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, '_plurnk', $source, $event_id,
    $op, $scheme, $hostname, $pathname, '', 'text/plain',
    $rx, $mimetype_rx, $status, $weight, $folded, $attrs
)
ON CONFLICT(worker_id, ambient_event_id) WHERE ambient_event_id IS NOT NULL DO NOTHING
RETURNING id;

-- PREP: engine_ambient_delta_id
-- Crash replay may find the observation row already inserted but its copied
-- classifications incomplete. Resolve that row so idempotent tag writes can finish.
SELECT id FROM log_entries WHERE worker_id = $worker_id AND ambient_event_id = $event_id;

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
-- runtime-tag entry), with content + mimetype + state + coordinate, so the per-turn injector can
-- publish the channel's next complete unit. Stays listed until its terminal observation is shown.
SELECT s.id AS subscription_id, e.scheme AS runtime, e.pathname AS coord,
    ec.name AS channel, ec.content AS content, ec.mimetype AS mimetype,
    ec.state AS state, s.close_status AS close_status,
    s.close_result AS close_result, s.published_channel AS published_channel
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
JOIN entry_channels ec ON ec.entry_id = s.entry_id
WHERE s.worker_id = $worker_id
  AND (s.published_channel IS NULL OR ec.name = s.published_channel)
ORDER BY s.id, ec.name;

-- PREP: engine_stream_cursor
-- {§exec-stream} — content offset already shown to the worker: the streamEnd recorded on its latest
-- foisted observation (the caller defaults to 0 when none exists yet).
SELECT attrs
FROM log_entries
WHERE worker_id = $worker_id AND origin = '_plurnk' AND op = 'READ'
    AND scheme = $scheme AND pathname = $pathname AND fragment IS $fragment
ORDER BY id DESC LIMIT 1;

-- PREP: engine_insert_stream_delta
-- {§exec-stream} / {§env-delta} — materialize a channel's next publishable content as a
-- foisted READ row (the model READs the stream it never typed). origin=_plurnk; fragment is
-- the channel; attrs.streamEnd is the next turn's cursor; terminal observations
-- are born open and ongoing observations wholly folded. {§exec-stream}
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source, model_call_id,
    op, scheme, pathname, fragment, tx, mimetype_tx, rx, mimetype_rx, status_rx, weight, attrs, folded
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, '_plurnk', NULL, NULL,
    'READ', $scheme, $pathname, $fragment, '', 'text/plain', $rx, 'application/json', $status, $weight, $attrs, $folded
);

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
-- them rot in log:///. Window = the current would-be model turn AND the immediately
-- preceding completed model turn: prior-model-turn for action failures the
-- model just caused, current-turn so a pre-generate engine error surfaces THIS turn
-- rather than a turn late. Packetless chronology never hides a model failure.
-- {§operation-result-uniform-error-channel}
WITH previous_model_turn AS (
    SELECT id
    FROM turns
    WHERE loop_id = $loop_id
      AND sequence < $current_turn_seq
      AND producer = 'model'
      AND kind = 'inference'
      AND completed_at IS NOT NULL
    ORDER BY sequence DESC
    LIMIT 1
)
SELECT
    le.origin, le.op, le.attrs, le.sequence, le.status_rx, le.rx, le.mimetype_rx,
    le.scheme, le.pathname,
    t.sequence AS turn_seq, l.sequence AS loop_seq
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.loop_id = $loop_id
  AND le.status_rx >= 400
  -- {§log-row-self-explains}: every >=400 row points at ITSELF — the op row carries its failure
  -- message on its meta line (packet-wire), so the pointer leads to a record that states its why.
  AND (
      t.sequence = $current_turn_seq
      OR t.id = (SELECT id FROM previous_model_turn)
  )
ORDER BY t.sequence, le.sequence;

-- PREP: overflow_turn_boundary_rows
-- {§overflow-turn-curation} — current pre-model rows and the immediately
-- preceding completed model turn are the complete automatic boundary.
WITH previous_model_turn AS (
    SELECT id
    FROM turns
    WHERE loop_id = $loop_id
      AND id < $turn_id
      AND producer = 'model'
      AND kind = 'inference'
      AND completed_at IS NOT NULL
    ORDER BY sequence DESC
    LIMIT 1
)
SELECT boundary.id,
       (loop.sequence || '/' || turn.sequence || '/' || boundary.sequence) AS coordinate,
       boundary.origin, boundary.op, boundary.attrs,
       boundary.tx, boundary.mimetype_tx, boundary.rx, boundary.mimetype_rx,
       boundary.folded
FROM log_entries boundary
JOIN turns turn ON turn.id = boundary.turn_id
JOIN loops loop ON loop.id = boundary.loop_id
WHERE boundary.loop_id = $loop_id
  AND COALESCE(boundary.op, '') NOT IN ('error', 'PLAN')
  AND COALESCE(boundary.scheme, '') != 'prompt'
  AND (boundary.turn_id = $turn_id OR boundary.turn_id = (SELECT id FROM previous_model_turn))
ORDER BY turn.sequence, boundary.sequence;

-- PREP: overflow_turn_open_effects
-- Re-fold only exact older intervals exposed by the previous model turn.
WITH previous_model_turn AS (
    SELECT id
    FROM turns
    WHERE loop_id = $loop_id
      AND id < $turn_id
      AND producer = 'model'
      AND kind = 'inference'
      AND completed_at IS NOT NULL
    ORDER BY sequence DESC
    LIMIT 1
)
SELECT target.id,
       (loop.sequence || '/' || turn.sequence || '/' || target.sequence) AS coordinate,
       target.origin, target.op, target.attrs,
       target.tx, target.mimetype_tx, target.rx, target.mimetype_rx,
       target.folded,
       effect.folded_before, effect.folded_after
FROM log_curation_effects effect
JOIN log_entries operation ON operation.id = effect.operation_log_entry_id
JOIN log_entries target ON target.id = effect.target_log_entry_id
JOIN turns turn ON turn.id = target.turn_id
JOIN loops loop ON loop.id = target.loop_id
WHERE operation.turn_id = (SELECT id FROM previous_model_turn)
  AND operation.op = 'OPEN'
  AND operation.status_rx < 400
  AND COALESCE(target.op, '') NOT IN ('error', 'PLAN')
  AND COALESCE(target.scheme, '') != 'prompt'
ORDER BY turn.sequence, target.sequence, operation.sequence;

-- PREP: engine_fold_log_entry
-- Fold one known log row by id. Model-emission rows use this after insertion so
-- the complete admitted emission remains available without opening by default.
UPDATE log_entries SET folded = '[[1,-1]]' WHERE id = $id;

-- PREP: engine_render_log
-- Render-time log-section assembly ({§body-projection}).
-- Yields log_entries for the whole worker — the conversation's working
-- memory carries across loops within a worker, not just the
-- current loop. Coordinates append /<op> only for rows that represent an operation.
-- Status 202 entries in state='proposed' are model-invisible until resolved.
-- Folded intervals are projected against the canonical body by packet-wire;
-- wholly folded rows remain listed and re-OPENable. {§open-fold}
SELECT
    le.id,
    l.sequence  AS loop_seq,
    t.sequence  AS turn_seq,
    le.sequence,
    -- le.origin is attribution, never a render filter; the worker's actor — {§actor-boundary-origin-not-filter} {§machine-processes-worker-origin}
    le.origin,
    le.op, le.delimiter, le.signal,
    le.scheme, le.username, le.password,
    le.hostname, le.port, le.pathname,
    le.query, le.fragment,
    le.status_rx, le.rx, le.mimetype_rx,
    le.tx, le.mimetype_tx,
    le.state, le.outcome, le.folded, le.source, le.weight, le.attrs,
    COALESCE((
        SELECT json_group_array(ordered.tag)
        FROM (
            SELECT tag FROM log_tags WHERE log_entry_id = le.id ORDER BY tag
        ) ordered
    ), '[]') AS tags
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
  AND NOT (
      COALESCE(le.op, '') IN ('OPEN', 'FOLD')
      AND le.status_rx < 400
      AND NOT (t.kind = 'overflow' AND le.origin = '_plurnk')
  )
  AND NOT (COALESCE(le.op, '') = 'KILL' AND le.scheme = 'log' AND le.status_rx < 400)
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: engine_insert_log_entry
-- Default state='resolved' covers the common path (non-proposing schemes
-- return their final status immediately). Status 202 + state='proposed'
-- triggers the proposal lifecycle (engine pauses dispatch; client resolves
-- via proposal resolution; entry transitions through engine_resolve_log_entry).
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source, model_call_id,
    op, delimiter, signal,
    scheme, username, password, hostname, port,
    pathname, query, fragment, lineMarker,
    tx, mimetype_tx, rx, mimetype_rx, status_rx, weight,
    state, outcome, attrs
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, $origin, $source, $model_call_id,
    $op, $delimiter, $signal,
    $scheme, $username, $password, $hostname, $port,
    $pathname, $query, $fragment, $lineMarker,
    $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $weight,
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
       weight = $weight,
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
       le.op AS op,
       le.attrs AS attrs,
       le.tx AS tx,
       le.mimetype_tx AS mimetype_tx,
       le.mimetype_rx AS mimetype_rx
  FROM log_entries le
  JOIN turns t ON t.id = le.turn_id
  JOIN loops l ON l.id = le.loop_id
 WHERE le.id = $id;

-- PREP: engine_turn_packet_boundaries
-- {§send-premature-terminate}/{§wait-obligation-matrix} — operations whose useful effect crosses
-- into the next packet: READ/FIND/OPEN/BARE results, plus successful FOLD context curation. Retrievals
-- block an explicit [200]; FOLD blocks only the empty-[202] inference because explicit final
-- housekeeping remains valid.
SELECT id, op FROM log_entries
WHERE turn_id = $turn_id
  AND origin = 'model'
  AND (op IN ('READ', 'FIND', 'OPEN', 'BARE') OR (op = 'FOLD' AND status_rx < 400));

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
        AND le.origin = '_plurnk'
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
-- Actionless engine errors are excluded because only model-authored failures can make
-- the model's concluding disposition blind. A model-authored statement that
-- failed grammar parsing is different: source='grammar' records a bounded operation failure
-- from the accepted emission, unseen until the next packet, so it gates completion like every
-- other failed model operation.
SELECT id FROM log_entries
WHERE turn_id = $turn_id
  AND origin = 'model'
  AND status_rx >= 400
  AND (op != 'error' OR source = 'grammar');

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

-- PREP: engine_worker_provider_identity
-- Provider routing uses globally unique opaque identities, while all relational
-- ownership and client coordinates retain the local integer worker id.
-- {§worker-provider-identity} {§worker-primary}
WITH RECURSIVE lineage(id, parent_worker_id, provider_identity) AS (
    SELECT id, parent_worker_id, provider_identity FROM workers WHERE id = $worker_id
    UNION ALL
    SELECT w.id, w.parent_worker_id, w.provider_identity
    FROM workers w JOIN lineage l ON w.id = l.parent_worker_id
)
SELECT current.provider_identity AS worker_id,
       root.provider_identity AS primary_worker_id
FROM workers current
JOIN lineage root ON root.parent_worker_id IS NULL
WHERE current.id = $worker_id;

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
