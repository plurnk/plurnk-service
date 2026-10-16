-- MIGRATE: 31 message openers
-- {§worker-obligations} A message a worker's own operation sends records that operation, by the row it writes:
-- its turn and its sequence there. The message's obligation then holds that worker by identity, its reply
-- reaches that worker, and a child's answer to its first message is its conclusion. A message a person, a
-- client or the daemon sends names no opener. Messages that predate the record name none either, so they hold
-- no worker and route no reply.
ALTER TABLE loop_messages ADD COLUMN opened_turn_id INTEGER REFERENCES turns(id) ON DELETE SET NULL;
ALTER TABLE loop_messages ADD COLUMN opened_sequence INTEGER CHECK (opened_sequence IS NULL OR opened_sequence >= 1);

-- {§methods-invocation}: the delivery that discharges a message finds it from either side.
CREATE INDEX loop_messages_opener ON loop_messages (opened_turn_id, opened_sequence) WHERE opened_turn_id IS NOT NULL;
CREATE INDEX message_completions_response ON message_completions (response_id);

DROP VIEW IF EXISTS delivered_message_replies;
DROP VIEW IF EXISTS message_reply_deliveries;
DROP VIEW IF EXISTS delegated_task_answers;
DROP VIEW IF EXISTS loop_obligations;
DROP VIEW IF EXISTS worker_obligations;

-- The worker whose own operation sent each message.
CREATE VIEW message_senders AS
SELECT m.id AS message_id, sender.worker_id AS sender_worker_id
FROM loop_messages m
JOIN turns opened ON opened.id = m.opened_turn_id
JOIN loops sender ON sender.id = opened.loop_id;

CREATE VIEW worker_obligations AS
SELECT w.id AS worker_id,
       EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.worker_id = w.id AND s.closed_at IS NULL AND s.detached = 0
       ) AS streams,
       EXISTS (
           SELECT 1 FROM workers c JOIN loops l ON l.worker_id = c.id
           WHERE c.parent_worker_id = w.id AND l.status IN (100, 102, 202)
       ) AS workers,
       EXISTS (
           SELECT 1 FROM message_senders s
           JOIN loop_messages m ON m.id = s.message_id
           JOIN loops l ON l.id = m.loop_id
           WHERE s.sender_worker_id = w.id
             AND l.status IN (100, 102, 202)
             AND NOT EXISTS (SELECT 1 FROM message_completions c WHERE c.message_id = m.id)
       ) AS messages
FROM workers w;

CREATE VIEW loop_obligations AS
SELECT l.id AS loop_id, held.streams, held.workers, held.messages
FROM loops l JOIN worker_obligations held ON held.worker_id = l.worker_id;

-- {§message-reply-delivery}: a reply reaches the message's own worker and the worker that sent it.
CREATE VIEW message_reply_deliveries AS
SELECT DISTINCT r.id AS source_record_id, r.loop_id, m.workspace_id,
       r.worker_id AS producer_worker_id, m.worker_id AS recipient_worker_id
FROM log_responses r
JOIN workers producer ON producer.id = r.worker_id
JOIN json_each(r.rx, '$.answers') answer
JOIN message_sources m ON m.path = answer.value AND m.workspace_id = producer.workspace_id
UNION
SELECT r.id, r.loop_id, m.workspace_id, r.worker_id, s.sender_worker_id
FROM log_responses r
JOIN workers producer ON producer.id = r.worker_id
JOIN json_each(r.rx, '$.answers') answer
JOIN message_sources m ON m.path = answer.value AND m.workspace_id = producer.workspace_id
JOIN message_senders s ON s.message_id = m.id;

-- {§worker-scheme-collect}: a child's answer to the first message its parent sent is its conclusion, not a reply.
CREATE VIEW delegated_task_answers AS
SELECT r.id AS source_record_id, producer.parent_worker_id AS recipient_worker_id
FROM log_responses r
JOIN workers producer ON producer.id = r.worker_id
JOIN json_each(r.rx, '$.answers') answer
JOIN message_sources m ON m.path = answer.value AND m.workspace_id = producer.workspace_id
JOIN message_senders s ON s.message_id = m.id
WHERE m.loop_id = r.loop_id AND m.ordinal = 1 AND s.sender_worker_id = producer.parent_worker_id;

CREATE VIEW delivered_message_replies AS
SELECT d.* FROM message_reply_deliveries d
WHERE NOT EXISTS (
    SELECT 1 FROM delegated_task_answers t
    WHERE t.source_record_id = d.source_record_id AND t.recipient_worker_id = d.recipient_worker_id
);
