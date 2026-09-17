-- PREP: message_history
-- {§message-envelope-evidence}: evidence is independent of log curation/publication.
SELECT m.id AS id, m.loop_id AS loop_id, 'inbound' AS direction, m.source, m.body, m.evidence
FROM loop_messages m
JOIN loops l ON l.id = m.loop_id
JOIN workers w ON w.id = l.worker_id
WHERE w.workspace_id = $workspace_id AND w.id = $worker_id
  AND ($loop_id IS NULL OR l.id = $loop_id)
UNION ALL
SELECT e.id, e.loop_id, 'outbound', e.source, COALESCE(json_extract(e.tx, '$.body.raw'), ''),
       json_object('attachments', json(COALESCE(json_extract(e.rx, '$.attachments'), '[]')))
FROM log_entries e
JOIN workers w ON w.id = e.worker_id
WHERE w.workspace_id = $workspace_id AND w.id = $worker_id
  AND ($loop_id IS NULL OR e.loop_id = $loop_id)
  AND e.op = 'SEND' AND e.origin != '_plurnk' AND e.status_rx BETWEEN 200 AND 299
  AND json_extract(e.tx, '$.target') IS NULL
ORDER BY loop_id, id;
