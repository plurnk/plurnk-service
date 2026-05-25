-- PREP: test_log_entries_table_sql
SELECT sql FROM sqlite_master WHERE name = 'log_entries';

-- PREP: test_log_entries_insert_full
INSERT INTO log_entries (
    run_id, loop_id, turn_id, action_index, origin, op, suffix, signal,
    scheme, pathname, port, params,
    lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, tokens
) VALUES (
    $run_id, $loop_id, $turn_id, $action_index, $origin, $op, $suffix, $signal,
    $scheme, $pathname, $port, $params,
    $lineMarker, $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $tokens
) RETURNING id;

-- PREP: test_log_entries_get_by_id
SELECT * FROM log_entries WHERE id = $id;

-- PREP: test_log_entries_get_tx_by_id
SELECT tx FROM log_entries WHERE id = $id;

-- PREP: test_log_entries_count_all
SELECT COUNT(*) AS n FROM log_entries;

-- PREP: test_log_entries_insert_minimal
INSERT INTO log_entries (run_id, loop_id, turn_id, action_index, origin, op, pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx)
VALUES ($run_id, $loop_id, $turn_id, 1, 'model', 'READ', '/x', '', 'text/x-plurnk', '', 'text/plain', 200)
RETURNING id;

-- PREP: test_log_entries_signals_by_turn
SELECT op, signal FROM log_entries WHERE turn_id = $turn_id ORDER BY action_index;

-- PREP: test_log_entries_address_join
SELECT le.op, l.sequence AS loop_seq, t.sequence AS turn_seq, le.action_index
FROM log_entries le
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.action_index = $action_index;

-- PREP: test_log_entries_indexes
SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'log_entries_%';

-- PREP: test_log_entries_update_tx
UPDATE log_entries SET tx = $tx WHERE id = $id;

-- PREP: test_log_entries_delete
DELETE FROM log_entries WHERE id = $id;

-- PREP: test_log_entries_delete_turns
DELETE FROM turns WHERE id = $id;

-- PREP: test_log_entries_insert_no_run_id
INSERT INTO log_entries (loop_id, turn_id, action_index, origin, op, tx, mimetype_tx, rx, mimetype_rx, status_rx)
VALUES ($loop_id, $turn_id, 1, 'model', 'READ', '', 'text/x-plurnk', '', 'text/plain', 200);
