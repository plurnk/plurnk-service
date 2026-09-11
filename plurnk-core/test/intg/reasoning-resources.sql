-- PREP: test_model_reasoning_resources
SELECT '/' || l.sequence || '/' || t.sequence AS pathname, s.content
FROM turn_sources s JOIN turns t ON t.id = s.turn_id JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND s.kind = 'reasoning' AND t.producer = 'model'
ORDER BY l.sequence, t.sequence;

-- PREP: test_reasoning_reads
SELECT le.id, le.turn_id, le.sequence, le.origin, le.ambient_event_id, le.pathname, le.lineMarker,
       le.rx, p.active, p.folded, l.sequence AS loop_seq, t.sequence AS turn_seq
FROM log_entries le JOIN log_entry_projections p ON p.log_entry_id = le.id
JOIN loops l ON l.id = le.loop_id JOIN turns t ON t.id = le.turn_id
WHERE le.worker_id = $worker_id AND le.op = 'READ' AND le.scheme = 'reasoning'
ORDER BY le.id;
