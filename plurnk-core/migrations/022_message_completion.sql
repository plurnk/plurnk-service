-- MIGRATE: 22 message completion
-- {§message-completion}: message outcome is independent of reply delivery and log curation.
CREATE TABLE message_completions (
    message_id INTEGER PRIMARY KEY REFERENCES loop_messages(id) ON DELETE CASCADE,
    response_id INTEGER NOT NULL REFERENCES log_entries(id),
    status INTEGER NOT NULL CHECK (status IN (200, 499))
) STRICT;
CREATE INDEX message_completions_response_id ON message_completions(response_id);

-- Before this contract, every delivered reply resolved its messages. Preserve that
-- established state without rewriting immutable operation evidence.
INSERT INTO message_completions (message_id, response_id, status)
SELECT m.id, MAX(r.id), 200
FROM message_sources m
JOIN workers w ON w.workspace_id = m.workspace_id
JOIN log_responses r ON r.worker_id = w.id
JOIN json_each(r.rx, '$.answers') a ON a.value = m.path
GROUP BY m.id;

DROP VIEW unanswered_messages;
CREATE VIEW unanswered_messages AS
SELECT m.* FROM message_sources m
WHERE NOT EXISTS (SELECT 1 FROM message_completions c WHERE c.message_id = m.id);
