-- PREP: engine_unconcluded_emission
-- {§terminal-evidence}: only an authored operation has a source position. Check the last turn,
-- not the last matching turn, so an earlier no-operation turn cannot replace later evidence.
SELECT CASE WHEN NOT EXISTS (
           SELECT 1 FROM json_each(t.packet, '$.assistant.ops') op
           WHERE json_extract(op.value, '$.position.line') > 0
       ) THEN s.content END AS retained,
       'ops://' || w.name || '/' || l.sequence || '/' || t.sequence AS resource
FROM turns t
JOIN loops l ON l.id = t.loop_id
JOIN workers w ON w.id = l.worker_id
LEFT JOIN turn_sources s ON s.turn_id = t.id AND s.kind = 'ops' AND s.sequence = 0
WHERE t.loop_id = $loop_id AND t.kind = 'inference'
ORDER BY t.sequence DESC LIMIT 1;
