-- MIGRATE: 26 message obligations
-- Released in 3.3.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§session-obligations}: a message a session sent to another session holds the sender, beside its live children
-- and open streams, until the recipient completes it ({§message-completion}) or the recipient's loop ends
-- ({§message-abandonment}). The two liveness views are recreated with that third column; no row changes.
DROP VIEW IF EXISTS loop_obligations;
DROP VIEW IF EXISTS session_obligations;

CREATE VIEW session_obligations AS
SELECT w.id AS session_id,
       EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.session_id = w.id AND s.closed_at IS NULL AND s.detached = 0
       ) AS streams,
       EXISTS (
           SELECT 1 FROM sessions c JOIN loops l ON l.session_id = c.id
           WHERE c.parent_session_id = w.id AND l.status IN (100, 102, 202)
       ) AS sessions,
       EXISTS (
           SELECT 1 FROM loop_messages m
           JOIN loops l ON l.id = m.loop_id
           JOIN sessions r ON r.id = l.session_id
           WHERE r.workspace_id = w.workspace_id
             AND m.source = 'session://' || w.name
             AND l.status IN (100, 102, 202)
             AND NOT EXISTS (SELECT 1 FROM message_completions c WHERE c.message_id = m.id)
       ) AS messages
FROM sessions w;

CREATE VIEW loop_obligations AS
SELECT l.id AS loop_id, held.streams, held.sessions, held.messages
FROM loops l JOIN session_obligations held ON held.session_id = l.session_id;
