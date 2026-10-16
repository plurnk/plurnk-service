-- Log-entry hydration for wire surfacing. {§methods-readable-reasoning}: a turn's admitted readable
-- reasoning rides its first model operation row, derived from the packet, never stored on a row.

-- PREP: log_entry_by_id
-- loop_seq / turn_seq are the loop+turn ordinals (the logical coordinate clients
-- render, e.g. 01/02/03) — distinct from the loop_id/turn_id DB keys ({§methods-log-coordinate}).
SELECT le.*, l.sequence AS loop_seq, t.sequence AS turn_seq,
       CASE
           WHEN le.origin = 'model'
            AND le.op IS NOT NULL
            AND le.sequence = (SELECT MIN(f.sequence) FROM log_entries f
                               WHERE f.turn_id = le.turn_id AND f.origin = 'model' AND f.op IS NOT NULL)
            AND json_type(t.packet, '$.assistant.reasoning') = 'text'
            AND length(json_extract(t.packet, '$.assistant.reasoning')) > 0
           THEN json_extract(t.packet, '$.assistant.reasoning')
       END AS reasoning,
       -- {§methods-readable-reasoning} The request that streamed it: the turn's accepted model call and that
       -- call's response request. History a FORK inherited names none.
       CASE WHEN le.origin = 'model' AND le.op IS NOT NULL THEN
           (SELECT s.model_call_id FROM turn_sources s WHERE s.turn_id = le.turn_id AND s.kind = 'ops' AND s.sequence = 0)
       END AS reasoning_model_call_id,
       CASE WHEN le.origin = 'model' AND le.op IS NOT NULL THEN
           (SELECT MAX(pr.sequence) FROM turn_sources s
            JOIN provider_requests pr ON pr.inference_call_id = s.model_call_id
            WHERE s.turn_id = le.turn_id AND s.kind = 'ops' AND s.sequence = 0 AND pr.outcome = 'response')
       END AS reasoning_request_sequence,
       -- {§methods-stream-invocation} The execution a stream observation observes, as its subscription recorded it.
       (SELECT s.source FROM subscription_publications sp JOIN subscriptions s ON s.id = sp.subscription_id
        WHERE sp.id = le.subscription_publication_id) AS invocation
FROM log_entries le
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE le.id = $id;

-- PREP: log_entries_recent
-- {§methods-log-read}: the newest rows a client asks for, hydrated exactly as log_entry_by_id
-- hydrates one — a page is one statement, never one statement per row.
SELECT le.*, l.sequence AS loop_seq, t.sequence AS turn_seq,
       CASE
           WHEN le.origin = 'model'
            AND le.op IS NOT NULL
            AND le.sequence = (SELECT MIN(f.sequence) FROM log_entries f
                               WHERE f.turn_id = le.turn_id AND f.origin = 'model' AND f.op IS NOT NULL)
            AND json_type(t.packet, '$.assistant.reasoning') = 'text'
            AND length(json_extract(t.packet, '$.assistant.reasoning')) > 0
           THEN json_extract(t.packet, '$.assistant.reasoning')
       END AS reasoning,
       -- {§methods-readable-reasoning} The request that streamed it: the turn's accepted model call and that
       -- call's response request. History a FORK inherited names none.
       CASE WHEN le.origin = 'model' AND le.op IS NOT NULL THEN
           (SELECT s.model_call_id FROM turn_sources s WHERE s.turn_id = le.turn_id AND s.kind = 'ops' AND s.sequence = 0)
       END AS reasoning_model_call_id,
       CASE WHEN le.origin = 'model' AND le.op IS NOT NULL THEN
           (SELECT MAX(pr.sequence) FROM turn_sources s
            JOIN provider_requests pr ON pr.inference_call_id = s.model_call_id
            WHERE s.turn_id = le.turn_id AND s.kind = 'ops' AND s.sequence = 0 AND pr.outcome = 'response')
       END AS reasoning_request_sequence,
       -- {§methods-stream-invocation} The execution a stream observation observes, as its subscription recorded it.
       (SELECT s.source FROM subscription_publications sp JOIN subscriptions s ON s.id = sp.subscription_id
        WHERE sp.id = le.subscription_publication_id) AS invocation
FROM log_entries le
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE le.worker_id = $worker_id
  AND ($loop_id IS NULL OR le.loop_id = $loop_id)
  AND ($turn_id IS NULL OR le.turn_id = $turn_id)
  AND ($since_id IS NULL OR le.id > $since_id)
  AND ($before_id IS NULL OR le.id < $before_id)
  AND ($loop_seq IS NULL OR l.sequence = $loop_seq)
  AND ($turn_seq IS NULL OR t.sequence = $turn_seq)
  AND ($sequence IS NULL OR le.sequence = $sequence)
ORDER BY le.id DESC
LIMIT $limit;
