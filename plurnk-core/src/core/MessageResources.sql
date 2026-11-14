-- PREP: message_history
-- {§op-methods-op-dispatch}: evidence is independent of log curation/publication.
SELECT m.id AS id, m.loop_id AS loop_id, 'inbound' AS direction, m.source, m.body, m.evidence, '[]' AS replied_to
FROM loop_messages m
JOIN loops l ON l.id = m.loop_id
JOIN sessions w ON w.id = l.session_id
WHERE w.workspace_id = $workspace_id AND w.id = $session_id
  AND ($loop_id IS NULL OR l.id = $loop_id)
UNION ALL
SELECT e.id, e.loop_id, 'outbound', e.source, e.content,
       json_object('attachments', json(COALESCE(json_extract(e.rx, '$.attachments'), '[]'))),
       json_extract(e.rx, '$.repliedTo')
FROM message_responses e
JOIN sessions w ON w.id = e.session_id
WHERE w.workspace_id = $workspace_id AND w.id = $session_id
  AND ($loop_id IS NULL OR e.loop_id = $loop_id)
  AND (length(trim(e.content, char(9) || char(10) || char(13) || ' ')) > 0
       OR json_array_length(e.rx, '$.attachments') > 0)
ORDER BY loop_id, id;
-- PREP: message_source_resources
-- A message keeps the address its minter gave it (`acp://…`), and {§message-arrival}
-- adds the short `message://<session>/<key>` alias the session docs teach.
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

-- PREP: message_inbox
-- {§methods}: accepted and not yet published ({§message-arrival}), in acceptance order, with the status of
-- the loop holding each ({§message-arrival}: one that concluded first will never publish it).
SELECT s.path, s.source, s.body, s.loop_id, l.status AS loop_status FROM message_sources s
JOIN loops l ON l.id = s.loop_id
WHERE s.workspace_id = $workspace_id AND s.session_id = $session_id AND s.log_entry_id IS NULL
ORDER BY s.loop_id, s.ordinal;

-- PREP: message_open
-- {§methods} {§message-completion}: accepted and not yet completed, in acceptance order, with the status of
-- the loop holding each.
SELECT s.path, s.source, s.body, s.loop_id, l.status AS loop_status FROM unanswered_messages s
JOIN loops l ON l.id = s.loop_id
WHERE s.workspace_id = $workspace_id AND s.session_id = $session_id
ORDER BY s.loop_id, s.ordinal;

-- PREP: message_latest_published
-- {§message-completion}: with none open, an untargeted reply addresses the loop's most recent published message
-- unless multiple distinct sender principals require an explicit target.
SELECT s.key_path, s.source, c.status AS completion_status
FROM message_sources s
LEFT JOIN message_completions c ON c.message_id = s.id
WHERE s.loop_id = $loop_id AND s.log_entry_id IS NOT NULL
ORDER BY s.ordinal DESC;

-- PREP: message_unanswered_count
SELECT count(*) AS count FROM unanswered_messages WHERE loop_id = $loop_id;

-- PREP: message_completion_outcome
-- {§message-completion}: any completed request wins; all-cancelled is cancellation.
SELECT CASE WHEN COUNT(*) > 0 AND MIN(c.status) = 499 THEN 499 ELSE 200 END AS status
FROM message_completions c JOIN loop_messages m ON m.id = c.message_id
WHERE m.loop_id = $loop_id;

-- PREP: message_complete_turn_on_wait
-- {§loop-completion} {§message-completion}: a turn with a resolved reply send and an idle wait
-- completes the loop's remaining published Open Messages.
INSERT INTO message_completions (message_id, response_id, status)
SELECT m.id, reply.id, COALESCE(json_extract(reply.rx, '$.completion'), 200)
FROM unanswered_messages m
JOIN (
    SELECT id, rx FROM log_entries
    WHERE turn_id = $turn_id
      AND op IN ('send', 'done', 'fail') AND origin = 'model' AND state = 'resolved'
      AND status_rx BETWEEN 200 AND 299
      AND source IS NULL AND inherited_history = 0
      AND json_valid(rx) AND json_array_length(rx, '$.repliedTo') > 0
    ORDER BY id DESC
    LIMIT 1
) reply
WHERE m.loop_id = $loop_id AND m.log_entry_id IS NOT NULL;

-- INIT: message_complete_on_reply
DROP TRIGGER IF EXISTS message_complete_on_reply;
CREATE TRIGGER message_complete_on_reply
AFTER INSERT ON log_entry_rows
WHEN NEW.op IN ('send', 'done', 'fail') AND NEW.state = 'resolved' AND NEW.status_rx BETWEEN 200 AND 299
    AND NEW.source IS NULL AND NEW.inherited_history = 0
    AND json_valid((SELECT content FROM contents WHERE id = NEW.rx_content_id))
    AND json_extract((SELECT content FROM contents WHERE id = NEW.rx_content_id), '$.completion') IN (200, 499)
BEGIN
    INSERT INTO message_completions (message_id, response_id, status)
    SELECT m.id, NEW.id, json_extract((SELECT content FROM contents WHERE id = NEW.rx_content_id), '$.completion')
    FROM message_sources m
    JOIN sessions w ON w.id = NEW.session_id AND w.workspace_id = m.workspace_id
    JOIN json_each((SELECT content FROM contents WHERE id = NEW.rx_content_id), '$.repliedTo') a ON a.value = m.key_path
    WHERE true
    ON CONFLICT(message_id) DO UPDATE SET response_id = excluded.response_id, status = excluded.status;
END;
