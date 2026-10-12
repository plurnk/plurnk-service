-- MIGRATE: 26 message obligations
-- {§worker-obligations}: a message a worker sent to another worker holds the sender, beside its live children
-- and open streams, until the recipient completes it ({§message-completion}) or the recipient's loop ends
-- ({§message-abandonment}). The two liveness views are recreated with that third column; no row changes.
DROP VIEW IF EXISTS loop_obligations;
DROP VIEW IF EXISTS worker_obligations;

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
           SELECT 1 FROM loop_messages m
           JOIN loops l ON l.id = m.loop_id
           JOIN workers r ON r.id = l.worker_id
           WHERE r.workspace_id = w.workspace_id
             AND m.source = 'worker://' || w.name
             AND l.status IN (100, 102, 202)
             AND NOT EXISTS (SELECT 1 FROM message_completions c WHERE c.message_id = m.id)
       ) AS messages
FROM workers w;

CREATE VIEW loop_obligations AS
SELECT l.id AS loop_id, held.streams, held.workers, held.messages
FROM loops l JOIN worker_obligations held ON held.worker_id = l.worker_id;
