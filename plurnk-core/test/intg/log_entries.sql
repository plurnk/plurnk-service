-- PREP: test_log_entries_table_sql
SELECT sql FROM sqlite_master WHERE name = 'log_entries';

-- PREP: test_log_entries_insert_full
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source, op, delimiter, signal,
    scheme, pathname, port, query,
    lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, weight, attrs
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, $origin, $source, $op, $delimiter, $signal,
    $scheme, $pathname, $port, $query,
    $lineMarker, $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $weight, $attrs
) RETURNING id;

-- PREP: test_log_entries_get_by_id
SELECT * FROM log_entries WHERE id = $id;

-- PREP: test_log_entries_get_tx_by_id
SELECT tx FROM log_entries WHERE id = $id;

-- PREP: test_log_entries_count_all
SELECT COUNT(*) AS n FROM log_entries;

-- PREP: test_log_entries_insert_minimal
INSERT INTO log_entries (worker_id, loop_id, turn_id, sequence, origin, op, pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx)
VALUES ($worker_id, $loop_id, $turn_id, 1, 'model', 'READ', '/x', '', 'text/x-plurnk', '', 'text/plain', 200)
RETURNING id;

-- PREP: test_log_entries_signals_by_turn
SELECT op, signal FROM log_entries WHERE turn_id = $turn_id ORDER BY sequence;

-- PREP: test_log_entries_address_join
SELECT le.op, l.sequence AS loop_seq, t.sequence AS turn_seq, le.sequence
FROM log_entries le
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: test_log_entries_indexes
SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'log_entries_%';

-- PREP: test_log_entries_update_tx
UPDATE log_entries SET tx = $tx WHERE id = $id;

-- PREP: test_log_entries_delete
DELETE FROM log_entries WHERE id = $id;

-- PREP: test_log_entries_delete_turns
DELETE FROM turns WHERE id = $id;

-- PREP: test_log_entries_insert_no_worker_id
INSERT INTO log_entries (loop_id, turn_id, sequence, origin, op, tx, mimetype_tx, rx, mimetype_rx, status_rx)
VALUES ($loop_id, $turn_id, 1, 'model', 'READ', '', 'text/x-plurnk', '', 'text/plain', 200);
