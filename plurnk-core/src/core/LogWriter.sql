-- LogWriter: the one insert every log row goes through.

-- PREP: engine_insert_log_entry
-- Default state='resolved' covers the common path (non-proposing schemes
-- return their final status immediately). Status 202 + state='proposed'
-- triggers the proposal lifecycle (engine pauses dispatch; client resolves
-- via proposal resolution; entry transitions through engine_resolve_log_entry).
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source, model_call_id,
    op, signal,
    scheme, username, password, hostname, port,
    pathname, query, fragment, lineMarker,
    tx, mimetype_tx, rx, mimetype_rx, status_rx, weight,
    state, outcome, attrs, initial_folded
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, $origin, $source, $model_call_id,
    $op, $signal,
    $scheme, $username, $password, $hostname, $port,
    $pathname, $query, $fragment, $lineMarker,
    $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $weight,
    $state, $outcome, $attrs, COALESCE($initial_folded, '[]')
)
RETURNING id;
