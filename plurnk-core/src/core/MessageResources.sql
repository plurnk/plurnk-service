-- PREP: message_history
-- {§message-envelope-evidence}: evidence is independent of log curation/publication.
SELECT m.id AS id, m.loop_id AS loop_id, 'inbound' AS direction, m.source, m.body, m.evidence
FROM loop_messages m
JOIN loops l ON l.id = m.loop_id
JOIN workers w ON w.id = l.worker_id
WHERE w.workspace_id = $workspace_id AND w.id = $worker_id
  AND ($loop_id IS NULL OR l.id = $loop_id)
UNION ALL
SELECT e.id, e.loop_id, 'outbound', e.source, e.content,
       json_object('attachments', json(COALESCE(json_extract(e.rx, '$.attachments'), '[]')))
FROM log_responses e
JOIN workers w ON w.id = e.worker_id
WHERE w.workspace_id = $workspace_id AND w.id = $worker_id
  AND ($loop_id IS NULL OR e.loop_id = $loop_id)
ORDER BY loop_id, id;
