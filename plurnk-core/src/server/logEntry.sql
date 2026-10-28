-- Log-entry hydration for wire surfacing. {§methods-invocation}: a turn's admitted readable
-- reasoning rides its first model operation row, derived from the packet, never stored on a row.

-- PREP: log_entry_by_id
-- loop_seq / turn_seq are the loop+turn ordinals (the logical coordinate clients
-- render, e.g. 01/02/03) — distinct from the loop_id/turn_id DB keys ({§methods-invocation}).
SELECT le.*, w.name AS session_name, l.sequence AS loop_seq, t.sequence AS turn_seq,
       CASE
           WHEN le.origin = 'model'
            AND le.op IS NOT NULL
            AND le.sequence = (SELECT MIN(f.sequence) FROM log_entries f
                               WHERE f.turn_id = le.turn_id AND f.origin = 'model' AND f.op IS NOT NULL)
            AND json_type(t.packet, '$.assistant.reasoning') = 'text'
            AND length(json_extract(t.packet, '$.assistant.reasoning')) > 0
           THEN json_extract(t.packet, '$.assistant.reasoning')
       END AS reasoning,
       -- {§methods-invocation} The request that streamed it: the turn's accepted model call and that
       -- call's response request. History a FORK inherited names none.
       CASE WHEN le.origin = 'model' AND le.op IS NOT NULL THEN
           (SELECT s.model_call_id FROM turn_sources s WHERE s.turn_id = le.turn_id AND s.kind = 'ops' AND s.sequence = 0)
       END AS reasoning_model_call_id,
       CASE WHEN le.origin = 'model' AND le.op IS NOT NULL THEN
           (SELECT MAX(pr.sequence) FROM turn_sources s
            JOIN provider_requests pr ON pr.inference_call_id = s.model_call_id
            WHERE s.turn_id = le.turn_id AND s.kind = 'ops' AND s.sequence = 0 AND pr.outcome = 'response')
       END AS reasoning_request_sequence,
       -- {§methods-invocation} The operation whose obligation this row discharges: a stream observation's execution,
       -- as its subscription recorded it; or the operation that sent the message a child's conclusion or a completion
       -- reply answers, when that operation is this log's.
       COALESCE(
           (SELECT s.source FROM subscription_publications sp JOIN subscriptions s ON s.id = sp.subscription_id
            WHERE sp.id = le.subscription_publication_id),
           (SELECT printf('log:///%d/%d/%d/%s', sender.sequence, opened.sequence, o.sequence, o.op)
            FROM ambient_events ae
            JOIN loop_messages m
              ON (ae.kind = 'loop_termination' AND m.loop_id = ae.source_record_id AND m.ordinal = 1)
              OR (ae.kind = 'reply' AND m.id IN (SELECT c.message_id FROM message_completions c WHERE c.response_id = ae.source_record_id))
            JOIN turns opened ON opened.id = m.opened_turn_id
            JOIN loops sender ON sender.id = opened.loop_id
            JOIN log_entries o ON o.turn_id = m.opened_turn_id AND o.sequence = m.opened_sequence
            WHERE ae.id = le.ambient_event_id AND (sender.session_id = le.session_id OR le.inherited_history = 1)
            LIMIT 1)
       ) AS invocation,
       -- {§methods-invocation} The operation of this log that sent the message a reply answers, whether the reply
       -- completes the message or reports progress.
       (SELECT printf('log:///%d/%d/%d/%s', sender.sequence, opened.sequence, o.sequence, o.op)
        FROM ambient_events ae
        JOIN log_responses r ON r.id = ae.source_record_id
        JOIN json_each(r.rx, '$.repliedTo') reply
        JOIN message_sources ms ON ms.key_path = reply.value AND ms.workspace_id = (SELECT w.workspace_id FROM sessions w WHERE w.id = le.session_id)
        JOIN loop_messages m ON m.id = ms.id
        JOIN turns opened ON opened.id = m.opened_turn_id
        JOIN loops sender ON sender.id = opened.loop_id
        JOIN log_entries o ON o.turn_id = m.opened_turn_id AND o.sequence = m.opened_sequence
        WHERE ae.id = le.ambient_event_id AND ae.kind = 'reply'
          AND (sender.session_id = le.session_id OR le.inherited_history = 1)
        LIMIT 1) AS answering
FROM log_entries le
JOIN sessions w ON w.id = le.session_id
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE le.id = $id;

-- PREP: log_entries_recent
-- {§methods}: the newest rows a client asks for, hydrated exactly as log_entry_by_id
-- hydrates one — a page is one statement, never one statement per row.
SELECT le.*, w.name AS session_name, l.sequence AS loop_seq, t.sequence AS turn_seq,
       CASE
           WHEN le.origin = 'model'
            AND le.op IS NOT NULL
            AND le.sequence = (SELECT MIN(f.sequence) FROM log_entries f
                               WHERE f.turn_id = le.turn_id AND f.origin = 'model' AND f.op IS NOT NULL)
            AND json_type(t.packet, '$.assistant.reasoning') = 'text'
            AND length(json_extract(t.packet, '$.assistant.reasoning')) > 0
           THEN json_extract(t.packet, '$.assistant.reasoning')
       END AS reasoning,
       -- {§methods-invocation} The request that streamed it: the turn's accepted model call and that
       -- call's response request. History a FORK inherited names none.
       CASE WHEN le.origin = 'model' AND le.op IS NOT NULL THEN
           (SELECT s.model_call_id FROM turn_sources s WHERE s.turn_id = le.turn_id AND s.kind = 'ops' AND s.sequence = 0)
       END AS reasoning_model_call_id,
       CASE WHEN le.origin = 'model' AND le.op IS NOT NULL THEN
           (SELECT MAX(pr.sequence) FROM turn_sources s
            JOIN provider_requests pr ON pr.inference_call_id = s.model_call_id
            WHERE s.turn_id = le.turn_id AND s.kind = 'ops' AND s.sequence = 0 AND pr.outcome = 'response')
       END AS reasoning_request_sequence,
       -- {§methods-invocation} The operation whose obligation this row discharges: a stream observation's execution,
       -- as its subscription recorded it; or the operation that sent the message a child's conclusion or a completion
       -- reply answers, when that operation is this log's.
       COALESCE(
           (SELECT s.source FROM subscription_publications sp JOIN subscriptions s ON s.id = sp.subscription_id
            WHERE sp.id = le.subscription_publication_id),
           (SELECT printf('log:///%d/%d/%d/%s', sender.sequence, opened.sequence, o.sequence, o.op)
            FROM ambient_events ae
            JOIN loop_messages m
              ON (ae.kind = 'loop_termination' AND m.loop_id = ae.source_record_id AND m.ordinal = 1)
              OR (ae.kind = 'reply' AND m.id IN (SELECT c.message_id FROM message_completions c WHERE c.response_id = ae.source_record_id))
            JOIN turns opened ON opened.id = m.opened_turn_id
            JOIN loops sender ON sender.id = opened.loop_id
            JOIN log_entries o ON o.turn_id = m.opened_turn_id AND o.sequence = m.opened_sequence
            WHERE ae.id = le.ambient_event_id AND (sender.session_id = le.session_id OR le.inherited_history = 1)
            LIMIT 1)
       ) AS invocation,
       -- {§methods-invocation} The operation of this log that sent the message a reply answers, whether the reply
       -- completes the message or reports progress.
       (SELECT printf('log:///%d/%d/%d/%s', sender.sequence, opened.sequence, o.sequence, o.op)
        FROM ambient_events ae
        JOIN log_responses r ON r.id = ae.source_record_id
        JOIN json_each(r.rx, '$.repliedTo') reply
        JOIN message_sources ms ON ms.key_path = reply.value AND ms.workspace_id = (SELECT w.workspace_id FROM sessions w WHERE w.id = le.session_id)
        JOIN loop_messages m ON m.id = ms.id
        JOIN turns opened ON opened.id = m.opened_turn_id
        JOIN loops sender ON sender.id = opened.loop_id
        JOIN log_entries o ON o.turn_id = m.opened_turn_id AND o.sequence = m.opened_sequence
        WHERE ae.id = le.ambient_event_id AND ae.kind = 'reply'
          AND (sender.session_id = le.session_id OR le.inherited_history = 1)
        LIMIT 1) AS answering
FROM log_entries le
JOIN sessions w ON w.id = le.session_id
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE le.session_id = $session_id
  AND ($loop_id IS NULL OR le.loop_id = $loop_id)
  AND ($turn_id IS NULL OR le.turn_id = $turn_id)
  AND ($since_id IS NULL OR le.id > $since_id)
  AND ($before_id IS NULL OR le.id < $before_id)
  AND ($loop_seq IS NULL OR l.sequence = $loop_seq)
  AND ($turn_seq IS NULL OR t.sequence = $turn_seq)
  AND ($sequence IS NULL OR le.sequence = $sequence)
ORDER BY le.id DESC
LIMIT $limit;
