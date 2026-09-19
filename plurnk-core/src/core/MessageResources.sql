-- PREP: message_history
-- {§message-envelope-evidence}: evidence is independent of log curation/publication.
SELECT m.id AS id, m.loop_id AS loop_id, 'inbound' AS direction, m.source, m.body, m.evidence, '[]' AS answers
FROM loop_messages m
JOIN loops l ON l.id = m.loop_id
JOIN workers w ON w.id = l.worker_id
WHERE w.workspace_id = $workspace_id AND w.id = $worker_id
  AND ($loop_id IS NULL OR l.id = $loop_id)
UNION ALL
SELECT e.id, e.loop_id, 'outbound', e.source, e.content,
       json_object('attachments', json(COALESCE(json_extract(e.rx, '$.attachments'), '[]'))),
       json_extract(e.rx, '$.answers')
FROM message_responses e
JOIN workers w ON w.id = e.worker_id
WHERE w.workspace_id = $workspace_id AND w.id = $worker_id
  AND ($loop_id IS NULL OR e.loop_id = $loop_id)
ORDER BY loop_id, id;
-- PREP: message_source_resources
-- A message keeps the address its minter gave it (`a2a://…`, `agui://…`), and {§message-short-identity}
-- adds the short `message://<worker>/<key>` alias the worker docs teach.
SELECT path, body FROM message_sources
WHERE workspace_id = $workspace_id AND path LIKE $scheme || '://%'
  AND ($target IS NULL OR path = $target)
UNION ALL
SELECT key_path AS path, body FROM message_sources
WHERE workspace_id = $workspace_id AND address IS NOT NULL AND $scheme = 'message'
  AND ($target IS NULL OR key_path = $target);

-- PREP: message_source_by_address
-- The short address the model is taught, or the durable one a client minted.
SELECT * FROM message_sources WHERE workspace_id = $workspace_id AND key_path = $path
UNION ALL
SELECT * FROM message_sources WHERE workspace_id = $workspace_id AND address = $path;

-- PREP: message_unanswered_count
SELECT count(*) AS count FROM unanswered_messages WHERE loop_id = $loop_id;
