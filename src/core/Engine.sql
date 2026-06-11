-- Engine SQL. SPEC §1 (architecture), §3 (op dispatch + log).

-- PREP: engine_loop_status
SELECT status FROM loops WHERE id = $loop_id;

-- PREP: engine_count_active_loops_for_run
-- Wake-on-completion uses this to decide whether to open a new loop or
-- let the existing one pick up the channel transition at the next turn
-- boundary. Status 102 = "in progress" (any non-terminal state).
SELECT COUNT(*) AS n FROM loops WHERE run_id = $run_id AND status = 102;

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
-- client-origin SEND[200] log entry for the prompt at sequence=0.
-- Prompts are first-class log entries (no synthetic / shim layer).
SELECT prompt, sequence FROM loops WHERE id = $loop_id;

-- PREP: engine_loop_cancel
UPDATE loops SET status = 499 WHERE id = $loop_id;

-- PREP: engine_loop_set_status
UPDATE loops SET status = $status WHERE id = $loop_id;

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_loop_turn_seqs
-- Look up (loop_seq, turn_seq) for a given (loop_id, turn_id). Used by
-- #writeLog when an op needs to address itself or its output by log
-- coordinate (e.g. EXEC's stream entry at exec://<loop_seq>/<turn_seq>/<sequence>/EXEC).
SELECT l.sequence AS loop_seq, t.sequence AS turn_seq
FROM loops l, turns t
WHERE l.id = $loop_id AND t.id = $turn_id;

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

-- PREP: engine_list_session_entries
-- Every entry of a session — all schemes, all channels — the source for
-- plurnk://manifest.json, the flat catalog of everything the session holds.
-- Session-scoped (persists across runs); FOLD doesn't drop from the catalog.
SELECT e.scheme, e.pathname, ec.name AS channel, ec.content, ec.mimetype, ec.tokens
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.scope = 'session' AND e.session_id = $session_id
ORDER BY e.scheme, e.pathname, ec.name;

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
    le.op, le.sequence, le.status_rx, le.rx, le.mimetype_rx,
    le.scheme, le.pathname,
    t.sequence AS turn_seq, l.sequence AS loop_seq
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.loop_id = $loop_id
  AND le.status_rx >= 400
  AND t.sequence = $current_turn_seq - 1
ORDER BY le.sequence;

-- PREP: engine_grinder_prior_turn_logs
-- §14.4 pass 1 (prior-turn rollback): the immediately-prior turn's still-open
-- log entries — the latest emissions that pushed the packet over. Folding them
-- (collapse to coordinate, not deleting) lightens the render; bodies persist, re-OPENable.
SELECT le.id, le.scheme
FROM log_entries le
WHERE le.loop_id = $loop_id AND le.indexed = 1
  AND le.turn_id = (SELECT MAX(id) FROM turns WHERE loop_id = $loop_id AND id < $turn_id);

-- PREP: engine_grinder_fold_prior_turn_logs
-- §14.4 pass 1: fold the prior turn's still-open logs in one set-op (same WHERE
-- as engine_grinder_prior_turn_logs above). Rows + bodies stay, re-OPENable.
UPDATE log_entries SET indexed = 0
WHERE loop_id = $loop_id AND indexed = 1
  AND turn_id = (SELECT MAX(id) FROM turns WHERE loop_id = $loop_id AND id < $turn_id);

-- PREP: engine_render_log
-- Render-time log assembly (SPEC §15 packet.system.log).
-- Yields log_entries for the whole RUN — the conversation's working
-- memory carries across loops within a session's run, not just the
-- current loop. Coordinate is log://<loop_seq>/<turn_seq>/<sequence>/<op>.
-- Status 202 entries in state='proposed' are model-invisible until resolved.
-- `indexed = 0` rows are FOLDED — listed but collapsed to their coordinate
-- (FOLD); the renderer elides the body. §6.3: folded rows stay listed, re-OPENable.
SELECT
    l.sequence  AS loop_seq,
    t.sequence  AS turn_seq,
    le.sequence,
    le.origin,
    le.op, le.suffix, le.signal,
    le.scheme, le.username, le.password,
    le.hostname, le.port, le.pathname,
    le.params, le.fragment,
    le.status_rx, le.rx, le.mimetype_rx,
    le.tx, le.mimetype_tx,
    le.state, le.outcome, le.indexed
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.run_id = $run_id
  AND NOT (le.status_rx = 202 AND le.state = 'proposed')
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: engine_insert_log_entry
-- Default state='resolved' covers the common path (non-proposing schemes
-- return their final status immediately). Status 202 + state='proposed'
-- triggers the proposal lifecycle (engine pauses dispatch; client resolves
-- via loop/resolve RPC; entry transitions through engine_resolve_log_entry).
INSERT INTO log_entries (
    run_id, loop_id, turn_id, sequence, origin,
    op, suffix, signal,
    scheme, username, password, hostname, port,
    pathname, params, fragment, lineMarker,
    tx, mimetype_tx, rx, mimetype_rx, status_rx, tokens,
    state, outcome, attrs
) VALUES (
    $run_id, $loop_id, $turn_id, $sequence, $origin,
    $op, $suffix, $signal,
    $scheme, $username, $password, $hostname, $port,
    $pathname, $params, $fragment, $lineMarker,
    $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $tokens,
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
