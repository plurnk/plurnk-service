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
  AND (length(trim(e.content, char(9) || char(10) || char(13) || ' ')) > 0
       OR json_array_length(e.rx, '$.attachments') > 0)
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

-- PREP: message_completion_outcome
-- {§message-completion}: any completed request wins; all-cancelled is cancellation.
SELECT CASE WHEN COUNT(*) > 0 AND MIN(c.status) = 499 THEN 499 ELSE 200 END AS status
FROM message_completions c JOIN loop_messages m ON m.id = c.message_id
WHERE m.loop_id = $loop_id;

-- INIT: message_complete_on_reply
DROP TRIGGER IF EXISTS message_complete_on_reply;
CREATE TRIGGER message_complete_on_reply
AFTER INSERT ON log_entries
WHEN NEW.op = 'SEND' AND NEW.state = 'resolved' AND NEW.status_rx BETWEEN 200 AND 299
    AND NEW.source IS NULL AND NEW.inherited_history = 0 AND json_valid(NEW.rx)
    AND json_extract(NEW.rx, '$.completion') IN (200, 499)
BEGIN
    INSERT INTO message_completions (message_id, response_id, status)
    SELECT m.id, NEW.id, json_extract(NEW.rx, '$.completion')
    FROM message_sources m
    JOIN workers w ON w.id = NEW.worker_id AND w.workspace_id = m.workspace_id
    JOIN json_each(NEW.rx, '$.answers') a ON a.value = m.path
    WHERE true
    ON CONFLICT(message_id) DO UPDATE SET response_id = excluded.response_id, status = excluded.status;
END;
