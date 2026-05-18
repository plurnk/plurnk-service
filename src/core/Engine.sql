-- Engine SQL. SPEC §1 (architecture), §3 (op dispatch + log), §5.2 (render index).

-- PREP: engine_loop_status
SELECT status FROM loops WHERE id = $loop_id;

-- PREP: engine_loop_cancel
UPDATE loops SET status = 499 WHERE id = $loop_id;

-- PREP: engine_loop_set_status
UPDATE loops SET status = $status WHERE id = $loop_id;

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_insert_turn
INSERT INTO turns (loop_id, sequence, status, packet, usage_completion)
VALUES ($loop_id, $sequence, $status, $packet, $usage_completion)
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

-- PREP: engine_insert_log_entry
INSERT INTO log_entries (
    run_id, loop_id, turn_id, action_index, origin,
    op, suffix, signal,
    target_scheme, target_username, target_password, target_hostname, target_port,
    target_pathname, target_params, target_fragment, lineMarker,
    tx, mimetype_tx, rx, mimetype_rx, status_rx
) VALUES (
    $run_id, $loop_id, $turn_id, $action_index, $origin,
    $op, $suffix, $signal,
    $target_scheme, $target_username, $target_password, $target_hostname, $target_port,
    $target_pathname, $target_params, $target_fragment, $lineMarker,
    $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx
)
RETURNING id;
