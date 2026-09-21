-- The emission a model turn left unconcluded, for the two readers that need it: the recovery
-- offer ({§conclusion-recovery}) and a loop terminal ({§terminal-evidence}).

-- PREP: engine_unconcluded_emission
-- The empty turn is the turn whose admitted program was empty; its retained text is what `200`
-- submits and what a terminal cites. `$before` bounds the search to turns preceding one turn —
-- the offer stands for exactly one turn, so it must never reach an older one — and is NULL for a
-- terminal, which wants the loop's last model turn. The emptiness test is projected, never
-- filtered: a turn that acted must end the search, not be skipped over to reach an older one.
SELECT CASE WHEN json_array_length(t.packet, '$.assistant.ops') = 0 THEN s.content END AS retained,
       'ops://' || w.name || '/' || l.sequence || '/' || t.sequence AS resource
FROM turns t
JOIN loops l ON l.id = t.loop_id
JOIN workers w ON w.id = l.worker_id
LEFT JOIN turn_sources s ON s.turn_id = t.id AND s.kind = 'ops' AND s.sequence = 0
WHERE t.loop_id = $loop_id AND t.kind = 'inference' AND ($before IS NULL OR t.sequence < $before)
ORDER BY t.sequence DESC LIMIT 1;
