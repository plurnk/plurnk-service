-- Log-entry hydration for wire surfacing. {§methods-invocation} {§turn-source-resources}: a turn's
-- admitted readable reasoning rides its first model operation row, derived from `turn_sources`
-- (`kind = 'reasoning'`), never duplicated onto a log row.

-- PREP: log_entry_by_id
-- loop_seq / turn_seq are the loop+turn ordinals (the logical coordinate clients
-- render, e.g. 01/02/03) — distinct from the loop_id/turn_id DB keys ({§methods-invocation}).
SELECT le.*, w.name AS session_name, l.sequence AS loop_seq, t.sequence AS turn_seq,
       CASE
           WHEN le.origin = 'model'
            AND le.op IS NOT NULL
            AND le.sequence = (SELECT MIN(f.sequence) FROM log_entries f
                               WHERE f.turn_id = le.turn_id AND f.origin = 'model' AND f.op IS NOT NULL)
           THEN COALESCE(
               (SELECT s.content FROM turn_sources s
                WHERE s.turn_id = le.turn_id AND s.kind = 'reasoning' AND s.sequence = 0 AND length(s.content) > 0),
               CASE
                   WHEN json_type(t.packet, '$.assistant.reasoning') = 'text'
                    AND length(json_extract(t.packet, '$.assistant.reasoning')) > 0
                   THEN json_extract(t.packet, '$.assistant.reasoning')
               END
           )
       END AS reasoning,
       -- {§methods-invocation} The request that streamed it: the turn's accepted model call and that
       -- call's response request. History a fork inherited names none.
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
              OR (ae.kind = 'reply' AND json_extract(ae.attrs, '$.messageId') IS NULL
                  AND m.id IN (SELECT c.message_id FROM message_completions c WHERE c.response_id = ae.source_record_id))
              OR (ae.kind = 'reply' AND m.id = json_extract(ae.attrs, '$.messageId'))
            JOIN turns opened ON opened.id = m.opened_turn_id
            JOIN loops sender ON sender.id = opened.loop_id
            JOIN log_entries o ON o.turn_id = m.opened_turn_id AND o.sequence = m.opened_sequence
            WHERE ae.id = le.ambient_event_id AND (sender.session_id = le.session_id OR le.inherited_history = 1)
            LIMIT 1)
       ) AS invocation,
       -- {§methods-invocation} The operation of this log that sent the message a reply answers, whether the reply
       -- completes the message or reports progress.
       COALESCE(
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
              AND json_extract(ae.attrs, '$.messageId') IS NULL
              AND (sender.session_id = le.session_id OR le.inherited_history = 1)
            LIMIT 1),
           (SELECT printf('log:///%d/%d/%d/%s', sender.sequence, opened.sequence, o.sequence, o.op)
            FROM ambient_events ae
            JOIN loop_messages m ON m.id = json_extract(ae.attrs, '$.messageId')
            JOIN turns opened ON opened.id = m.opened_turn_id
            JOIN loops sender ON sender.id = opened.loop_id
            JOIN log_entries o ON o.turn_id = m.opened_turn_id AND o.sequence = m.opened_sequence
            WHERE ae.id = le.ambient_event_id AND ae.kind = 'reply'
              AND (sender.session_id = le.session_id OR le.inherited_history = 1)
            LIMIT 1)
       ) AS answering,
       CASE
           WHEN le.op IN ('send', 'done', 'fail') AND json_valid(le.rx) AND json_type(le.rx, '$.repliedTo') = 'array'
           THEN (
               SELECT json_group_array(COALESCE(ms.source, ms.path))
               FROM json_each(le.rx, '$.repliedTo') reply
               JOIN message_sources ms ON ms.key_path = reply.value AND ms.workspace_id = w.workspace_id
           )
           WHEN le.origin = 'model' AND le.op = 'wait'
            AND (
                (json_valid(le.tx) AND length(trim(COALESCE(json_extract(le.tx, '$.body'), json_extract(le.tx, '$.aside'), ''))) > 0)
                OR (json_valid(le.attrs) AND length(trim(COALESCE(json_extract(le.attrs, '$.body'), json_extract(le.attrs, '$.aside'), ''))) > 0)
            )
           THEN (
               SELECT json_group_array(open_msg.src)
               FROM (
                   SELECT COALESCE(ms.source, ms.path) AS src
                   FROM message_sources ms
                   WHERE ms.loop_id = le.loop_id
                     AND ms.log_entry_id IS NOT NULL
                     AND ms.log_entry_id < le.id
                     AND NOT EXISTS (
                         SELECT 1 FROM message_completions c
                         WHERE c.message_id = ms.id
                           AND c.response_id IS NOT NULL
                           AND c.response_id < le.id
                     )
                   ORDER BY ms.ordinal ASC
               ) open_msg
           )
       END AS replied_to_sources,
       CASE
           WHEN le.op IN ('send', 'done', 'fail') AND json_valid(le.rx) AND json_type(le.rx, '$.repliedTo') = 'array'
           THEN (
               SELECT json_group_array(json(open_actor.actor_json))
               FROM (
                   SELECT json_extract(ms.evidence, '$.actor') AS actor_json
                   FROM json_each(le.rx, '$.repliedTo') reply
                   JOIN message_sources ms ON ms.key_path = reply.value AND ms.workspace_id = w.workspace_id
                   WHERE json_valid(ms.evidence) AND json_type(ms.evidence, '$.actor') = 'object'
                   ORDER BY reply.key ASC
               ) open_actor
           )
           WHEN le.origin = 'model' AND le.op = 'wait'
            AND (
                (json_valid(le.tx) AND length(trim(COALESCE(json_extract(le.tx, '$.body'), json_extract(le.tx, '$.aside'), ''))) > 0)
                OR (json_valid(le.attrs) AND length(trim(COALESCE(json_extract(le.attrs, '$.body'), json_extract(le.attrs, '$.aside'), ''))) > 0)
            )
           THEN (
               SELECT json_group_array(json(open_actor.actor_json))
               FROM (
                   SELECT json_extract(ms.evidence, '$.actor') AS actor_json
                   FROM message_sources ms
                   WHERE ms.loop_id = le.loop_id
                     AND ms.log_entry_id IS NOT NULL
                     AND ms.log_entry_id < le.id
                     AND json_valid(ms.evidence)
                     AND json_type(ms.evidence, '$.actor') = 'object'
                     AND NOT EXISTS (
                         SELECT 1 FROM message_completions c
                         WHERE c.message_id = ms.id
                           AND c.response_id IS NOT NULL
                           AND c.response_id < le.id
                     )
                   ORDER BY ms.ordinal ASC
               ) open_actor
           )
       END AS replied_to_actors
FROM log_entries le
JOIN sessions w ON w.id = le.session_id
JOIN loops l ON l.id = le.loop_id
JOIN turns t ON t.id = le.turn_id
WHERE le.id = $id;

-- PREP: log_entry_aside_at_coordinate
-- {§methods}: causal aside for an open stream's opening log coordinate.
SELECT COALESCE(
           CASE WHEN le.mimetype_tx = 'application/json' AND json_valid(le.tx)
                THEN json_extract(le.tx, '$.aside') END,
           json_extract(le.attrs, '$.aside')
       ) AS aside
FROM loops l
JOIN turns t ON t.loop_id = l.id AND t.sequence = $turn_seq
JOIN log_entries le ON le.turn_id = t.id AND le.sequence = $sequence
WHERE l.session_id = $session_id AND l.sequence = $loop_seq;

-- PREP: log_entries_recent
-- {§methods}: the newest rows a client asks for, hydrated exactly as log_entry_by_id
-- hydrates one — a page is one statement, never one statement per row.
SELECT le.*, w.name AS session_name, l.sequence AS loop_seq, t.sequence AS turn_seq,
       CASE
           WHEN le.origin = 'model'
            AND le.op IS NOT NULL
            AND le.sequence = (SELECT MIN(f.sequence) FROM log_entries f
                               WHERE f.turn_id = le.turn_id AND f.origin = 'model' AND f.op IS NOT NULL)
           THEN COALESCE(
               (SELECT s.content FROM turn_sources s
                WHERE s.turn_id = le.turn_id AND s.kind = 'reasoning' AND s.sequence = 0 AND length(s.content) > 0),
               CASE
                   WHEN json_type(t.packet, '$.assistant.reasoning') = 'text'
                    AND length(json_extract(t.packet, '$.assistant.reasoning')) > 0
                   THEN json_extract(t.packet, '$.assistant.reasoning')
               END
           )
       END AS reasoning,
       -- {§methods-invocation} The request that streamed it: the turn's accepted model call and that
       -- call's response request. History a fork inherited names none.
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
              OR (ae.kind = 'reply' AND json_extract(ae.attrs, '$.messageId') IS NULL
                  AND m.id IN (SELECT c.message_id FROM message_completions c WHERE c.response_id = ae.source_record_id))
              OR (ae.kind = 'reply' AND m.id = json_extract(ae.attrs, '$.messageId'))
            JOIN turns opened ON opened.id = m.opened_turn_id
            JOIN loops sender ON sender.id = opened.loop_id
            JOIN log_entries o ON o.turn_id = m.opened_turn_id AND o.sequence = m.opened_sequence
            WHERE ae.id = le.ambient_event_id AND (sender.session_id = le.session_id OR le.inherited_history = 1)
            LIMIT 1)
       ) AS invocation,
       -- {§methods-invocation} The operation of this log that sent the message a reply answers, whether the reply
       -- completes the message or reports progress.
       COALESCE(
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
              AND json_extract(ae.attrs, '$.messageId') IS NULL
              AND (sender.session_id = le.session_id OR le.inherited_history = 1)
            LIMIT 1),
           (SELECT printf('log:///%d/%d/%d/%s', sender.sequence, opened.sequence, o.sequence, o.op)
            FROM ambient_events ae
            JOIN loop_messages m ON m.id = json_extract(ae.attrs, '$.messageId')
            JOIN turns opened ON opened.id = m.opened_turn_id
            JOIN loops sender ON sender.id = opened.loop_id
            JOIN log_entries o ON o.turn_id = m.opened_turn_id AND o.sequence = m.opened_sequence
            WHERE ae.id = le.ambient_event_id AND ae.kind = 'reply'
              AND (sender.session_id = le.session_id OR le.inherited_history = 1)
            LIMIT 1)
       ) AS answering,
       CASE
           WHEN le.op IN ('send', 'done', 'fail') AND json_valid(le.rx) AND json_type(le.rx, '$.repliedTo') = 'array'
           THEN (
               SELECT json_group_array(COALESCE(ms.source, ms.path))
               FROM json_each(le.rx, '$.repliedTo') reply
               JOIN message_sources ms ON ms.key_path = reply.value AND ms.workspace_id = w.workspace_id
           )
           WHEN le.origin = 'model' AND le.op = 'wait'
            AND (
                (json_valid(le.tx) AND length(trim(COALESCE(json_extract(le.tx, '$.body'), json_extract(le.tx, '$.aside'), ''))) > 0)
                OR (json_valid(le.attrs) AND length(trim(COALESCE(json_extract(le.attrs, '$.body'), json_extract(le.attrs, '$.aside'), ''))) > 0)
            )
           THEN (
               SELECT json_group_array(open_msg.src)
               FROM (
                   SELECT COALESCE(ms.source, ms.path) AS src
                   FROM message_sources ms
                   WHERE ms.loop_id = le.loop_id
                     AND ms.log_entry_id IS NOT NULL
                     AND ms.log_entry_id < le.id
                     AND NOT EXISTS (
                         SELECT 1 FROM message_completions c
                         WHERE c.message_id = ms.id
                           AND c.response_id IS NOT NULL
                           AND c.response_id < le.id
                     )
                   ORDER BY ms.ordinal ASC
               ) open_msg
           )
       END AS replied_to_sources,
       CASE
           WHEN le.op IN ('send', 'done', 'fail') AND json_valid(le.rx) AND json_type(le.rx, '$.repliedTo') = 'array'
           THEN (
               SELECT json_group_array(json(open_actor.actor_json))
               FROM (
                   SELECT json_extract(ms.evidence, '$.actor') AS actor_json
                   FROM json_each(le.rx, '$.repliedTo') reply
                   JOIN message_sources ms ON ms.key_path = reply.value AND ms.workspace_id = w.workspace_id
                   WHERE json_valid(ms.evidence) AND json_type(ms.evidence, '$.actor') = 'object'
                   ORDER BY reply.key ASC
               ) open_actor
           )
           WHEN le.origin = 'model' AND le.op = 'wait'
            AND (
                (json_valid(le.tx) AND length(trim(COALESCE(json_extract(le.tx, '$.body'), json_extract(le.tx, '$.aside'), ''))) > 0)
                OR (json_valid(le.attrs) AND length(trim(COALESCE(json_extract(le.attrs, '$.body'), json_extract(le.attrs, '$.aside'), ''))) > 0)
            )
           THEN (
               SELECT json_group_array(json(open_actor.actor_json))
               FROM (
                   SELECT json_extract(ms.evidence, '$.actor') AS actor_json
                   FROM message_sources ms
                   WHERE ms.loop_id = le.loop_id
                     AND ms.log_entry_id IS NOT NULL
                     AND ms.log_entry_id < le.id
                     AND json_valid(ms.evidence)
                     AND json_type(ms.evidence, '$.actor') = 'object'
                     AND NOT EXISTS (
                         SELECT 1 FROM message_completions c
                         WHERE c.message_id = ms.id
                           AND c.response_id IS NOT NULL
                           AND c.response_id < le.id
                     )
                   ORDER BY ms.ordinal ASC
               ) open_actor
           )
       END AS replied_to_actors
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
  AND ($before_loop_seq IS NULL OR l.sequence < $before_loop_seq)
  AND ($after_loop_seq IS NULL OR l.sequence > $after_loop_seq)
  AND ($last_loops IS NULL OR le.loop_id IN (
      SELECT wl.id
      FROM (
          SELECT DISTINCT wle.loop_id AS id, wl2.sequence AS sequence
          FROM log_entries wle
          JOIN loops wl2 ON wl2.id = wle.loop_id
          WHERE wle.session_id = $session_id
            AND ($before_loop_seq IS NULL OR wl2.sequence < $before_loop_seq)
            AND ($after_loop_seq IS NULL OR wl2.sequence > $after_loop_seq)
      ) wl
      ORDER BY
          CASE WHEN $after_loop_seq IS NOT NULL THEN wl.sequence END ASC,
          CASE WHEN $after_loop_seq IS NULL THEN wl.sequence END DESC
      LIMIT $last_loops
  ))
  AND ($turn_seq IS NULL OR t.sequence = $turn_seq)
  AND ($sequence IS NULL OR le.sequence = $sequence)
ORDER BY le.id DESC
LIMIT $limit;
