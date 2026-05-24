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

-- PREP: engine_get_loop_prompt
-- Loop's prompt + sequence — runTurn reads it on turn 1 to write a
-- client-origin SEND[200] log entry for the prompt at action_index=0.
-- Prompts are first-class log entries (no synthetic / shim layer).
SELECT prompt, sequence FROM loops WHERE id = $loop_id;

-- PREP: engine_loop_cancel
UPDATE loops SET status = 499 WHERE id = $loop_id;

-- PREP: engine_loop_set_status
UPDATE loops SET status = $status WHERE id = $loop_id;

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_open_turn
-- Turn-as-container model: insert a turn row at runTurn open with a
-- placeholder packet and status=102 (in-progress). Pre-model writes
-- (the user prompt; later, system signals/telemetry events) land into
-- this row before the provider is called. The turn is then "closed"
-- via engine_close_turn with the final packet + status + usage stats
-- after dispatch completes.
INSERT INTO turns (loop_id, sequence, status, packet)
VALUES ($loop_id, $sequence, 102, '{}')
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
    usage_cached = $usage_cached,
    usage_cost_pico = $usage_cost_pico,
    finish_reason = $finish_reason,
    model = $model
WHERE id = $id;

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
-- SPEC §15.1: action-bound failures from the immediately previous turn
-- are mirrored into the next packet's telemetry.errors[]. Forces the
-- model to confront 4xx/5xx outcomes instead of letting them rot in
-- log://. "Previous turn" = sequence one below the currently-open one
-- (turn-as-container model: the current turn exists with status=102
-- when this query fires, so we explicitly look one back).
SELECT
    le.op, le.action_index, le.status_rx, le.rx, le.mimetype_rx,
    le.scheme, le.pathname,
    t.sequence AS turn_seq, l.sequence AS loop_seq
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.loop_id = $loop_id
  AND le.status_rx >= 400
  AND t.sequence = $current_turn_seq - 1
ORDER BY le.action_index;

-- PREP: engine_render_log
-- Render-time log assembly (SPEC §15 packet.system.log, task #44).
-- Yields log_entries for the whole RUN — the conversation's working
-- memory carries across loops within a session's run, not just the
-- current loop. Coordinate is log://<loop_seq>/<turn_seq>/<action_index>.
-- Status 202 entries in state='proposed' are model-invisible until resolved.
SELECT
    l.sequence  AS loop_seq,
    t.sequence  AS turn_seq,
    le.action_index,
    le.origin,
    le.op, le.suffix, le.signal,
    le.scheme, le.username, le.password,
    le.hostname, le.port, le.pathname,
    le.params, le.fragment,
    le.status_rx, le.rx, le.mimetype_rx,
    le.state, le.outcome
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.run_id = $run_id
  AND NOT (le.status_rx = 202 AND le.state = 'proposed')
ORDER BY l.sequence, t.sequence, le.action_index;

-- PREP: engine_insert_log_entry
-- Default state='resolved' covers the common path (non-proposing schemes
-- return their final status immediately). Status 202 + state='proposed'
-- triggers the proposal lifecycle (engine pauses dispatch; client resolves
-- via loop/resolve RPC; entry transitions through engine_resolve_log_entry).
INSERT INTO log_entries (
    run_id, loop_id, turn_id, action_index, origin,
    op, suffix, signal,
    scheme, username, password, hostname, port,
    pathname, params, fragment, lineMarker,
    tx, mimetype_tx, rx, mimetype_rx, status_rx,
    state, outcome, attrs
) VALUES (
    $run_id, $loop_id, $turn_id, $action_index, $origin,
    $op, $suffix, $signal,
    $scheme, $username, $password, $hostname, $port,
    $pathname, $params, $fragment, $lineMarker,
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
