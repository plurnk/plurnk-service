-- PREP: test_reasoning_history
SELECT le.id, le.sequence, le.turn_id, le.rx AS original,
       current.rx AS working, projection.active,
       l.sequence AS loop_seq, t.sequence AS turn_seq
FROM log_entries le
JOIN log_entry_projections projection ON projection.log_entry_id = le.id
LEFT JOIN active_log_entries current ON current.id = le.id
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.worker_id = $worker_id AND json_extract(le.attrs, '$.kind') = 'reasoning'
ORDER BY le.id;

-- PREP: test_reasoning_mutate_original
UPDATE log_entries SET rx = $rx WHERE id = $id;

-- PREP: test_reasoning_set_body_turn
UPDATE log_entry_projections SET body_turn_id = $turn_id WHERE log_entry_id = $id;
