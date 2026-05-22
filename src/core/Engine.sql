-- Engine SQL. SPEC §1 (architecture), §3 (op dispatch + log), §5.2 (render index).

-- PREP: engine_loop_status
SELECT status FROM loops WHERE id = $loop_id;

-- PREP: engine_get_loop_flags
-- Loads the loop's persisted flags (json). Default '{}'; YOLO listener and
-- SchemeRegistry.resolveForLoop merge over DEFAULT_LOOP_FLAGS for missing
-- fields. Migration 014.
SELECT flags FROM loops WHERE id = $loop_id;

-- PREP: engine_set_loop_flags
-- Updates the loop's persisted flags (json). Called by loop.run RPC handler.
UPDATE loops SET flags = $flags WHERE id = $loop_id;

-- PREP: engine_resolve_persona
-- Persona cascade (issue #150, migration 016). Returns the first non-null
-- value across loops.persona, runs.persona, sessions.persona for the given
-- loop_id. Falls through to NULL if no override was set at any level;
-- caller (#buildRequestPacket) treats NULL as "use file default."
SELECT COALESCE(l.persona, r.persona, s.persona) AS persona
FROM loops l
JOIN runs r ON r.id = l.run_id
JOIN sessions s ON s.id = r.session_id
WHERE l.id = $loop_id;

-- PREP: engine_loop_cancel
UPDATE loops SET status = 499 WHERE id = $loop_id;

-- PREP: engine_loop_set_status
UPDATE loops SET status = $status WHERE id = $loop_id;

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_insert_turn
INSERT INTO turns (
    loop_id, sequence, status, packet,
    usage_prompt, usage_completion, usage_cached, usage_cost_pico,
    finish_reason, model
)
VALUES (
    $loop_id, $sequence, $status, $packet,
    $usage_prompt, $usage_completion, $usage_cached, $usage_cost_pico,
    $finish_reason, $model
)
RETURNING id;

-- PREP: engine_render_index
-- Render-time index assembly (SPEC §5.2 {§5.2-render-filters-by-indexed}).
-- Yields one row per (entry, channel) where visibility.indexed = 1 for the run.
SELECT
    e.id AS entry_id, e.version, e.scope, e.session_id,
    e.scheme, e.username, e.password, e.hostname, e.port,
    e.pathname, e.params, e.attributes,
    ec.name AS channel, ec.content, ec.mimetype, ec.tokens
FROM visibility v
JOIN entries e ON e.id = v.entry_id
JOIN entry_channels ec ON ec.entry_id = v.entry_id AND ec.name = v.channel
WHERE v.run_id = $run_id AND v.indexed = 1
ORDER BY e.id, ec.name;

-- PREP: engine_entry_tags
SELECT tag FROM entry_tags WHERE entry_id = $entry_id ORDER BY tag;

-- PREP: engine_render_telemetry_errors
-- SPEC §15.1: action-bound failures from the immediately previous turn are
-- mirrored into the next packet's telemetry.errors[]. Forces the model to
-- confront 4xx/5xx outcomes instead of letting them rot in log://.
SELECT
    le.op, le.action_index, le.status_rx, le.rx, le.mimetype_rx,
    le.target_scheme, le.target_pathname,
    t.sequence AS turn_seq, l.sequence AS loop_seq
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.loop_id = $loop_id
  AND le.status_rx >= 400
  AND t.sequence = (SELECT MAX(sequence) FROM turns WHERE loop_id = $loop_id)
ORDER BY le.action_index;

-- PREP: engine_render_log
-- Render-time log assembly (SPEC §15 packet.system.log, task #44).
-- Yields log_entries for this loop, joined with the turn's sequence so the
-- model gets a stable log://<loop_seq>/<turn_seq>/<action_index> coordinate.
-- Status 202 entries in state='proposed' are model-invisible until resolved
-- (rummy SPEC #message_structure). Once state transitions to resolved/failed/
-- cancelled the entry surfaces in the next packet's log.
SELECT
    l.sequence  AS loop_seq,
    t.sequence  AS turn_seq,
    le.action_index,
    le.origin,
    le.op, le.suffix, le.signal,
    le.target_scheme, le.target_username, le.target_password,
    le.target_hostname, le.target_port, le.target_pathname,
    le.target_params, le.target_fragment,
    le.status_rx, le.rx, le.mimetype_rx,
    le.state, le.outcome
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.loop_id = $loop_id
  AND NOT (le.status_rx = 202 AND le.state = 'proposed')
ORDER BY t.sequence, le.action_index;

-- PREP: engine_insert_log_entry
-- Default state='resolved' covers the common path (non-proposing schemes
-- return their final status immediately). Status 202 + state='proposed'
-- triggers the proposal lifecycle (engine pauses dispatch; client resolves
-- via loop/resolve RPC; entry transitions through engine_resolve_log_entry).
INSERT INTO log_entries (
    run_id, loop_id, turn_id, action_index, origin,
    op, suffix, signal,
    target_scheme, target_username, target_password, target_hostname, target_port,
    target_pathname, target_params, target_fragment, lineMarker,
    tx, mimetype_tx, rx, mimetype_rx, status_rx,
    state, outcome, attrs
) VALUES (
    $run_id, $loop_id, $turn_id, $action_index, $origin,
    $op, $suffix, $signal,
    $target_scheme, $target_username, $target_password, $target_hostname, $target_port,
    $target_pathname, $target_params, $target_fragment, $lineMarker,
    $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx,
    $state, $outcome, $attrs
)
RETURNING id;

-- PREP: engine_resolve_log_entry
-- Transitions a proposed log entry to its terminal state. Used by the
-- proposal lifecycle (loop/resolve RPC, YOLO auto-accept, timeout, abort).
-- Updates status_rx + rx + state + outcome atomically.
UPDATE log_entries
   SET state = $state,
       outcome = $outcome,
       status_rx = $status_rx,
       rx = $rx
 WHERE id = $id
   AND state = 'proposed';
