-- ApplicationPort readSessionOverview queries. SPEC {§methods-workspace-create}.

-- PREP: overview_places
-- {§application-session-observation}: the places in scope, each with its loops' observations for its lifecycle
-- ({§application-session-observation}) and its latest finished reply ({§message-completion}), without the reply's words.
-- {§machine-processes} An archived session is out of scope, and in the daemon's scope so is every session of an archived workspace.
-- Unbounded by SQL LIMIT because SessionOverview.hold retains gated sessions past `limit` from in-memory gate state and
-- computes `omitted` across the full in-scope set.
SELECT w.id, w.workspace_id AS workspaceId, w.name, w.parent_session_id AS parentSessionId,
       parent.name AS parentName, parent.origin AS parentOrigin,
       w.title, w.persona,
       CASE WHEN w.fork_event_boundary IS NOT NULL THEN 'fork'
            WHEN w.parent_session_id IS NOT NULL THEN 'work'
            ELSE 'root' END AS kind,
       (SELECT json_group_array(json_object('status', l.status, 'sequence', l.sequence, 'terminatedAt', l.terminated_at))
          FROM work_loops l WHERE l.session_id = w.id) AS loopObservations,
       reply.id AS replyId,
       reply.at AS replyAt,
       COALESCE(
           CASE WHEN reply.mimetype_rx = 'application/json' AND json_valid(reply.rx)
                THEN json_extract(reply.rx, '$.completion') END,
           (SELECT MIN(c.status) FROM message_completions c WHERE c.response_id = reply.id)
       ) AS replyCompletion,
       CASE WHEN reply.id IS NULL THEN NULL
            ELSE printf('%d/%d/%d', reply_loop.sequence, reply_turn.sequence, reply.sequence) END AS replyCoordinate
FROM sessions w
LEFT JOIN sessions parent ON parent.id = w.parent_session_id
LEFT JOIN log_entries reply ON reply.id = (
    SELECT le.id FROM log_entries le
    WHERE le.session_id = w.id
      AND le.op IN ('send', 'done', 'fail') AND le.origin = 'model' AND le.inherited_history = 0
      AND le.state = 'resolved' AND le.status_rx < 400
      AND COALESCE(
          CASE WHEN le.mimetype_rx = 'application/json' AND json_valid(le.rx)
               THEN json_extract(le.rx, '$.completion') END,
          (SELECT MIN(c.status) FROM message_completions c WHERE c.response_id = le.id)
      ) IN (200, 499)
    ORDER BY le.id DESC
    LIMIT 1)
LEFT JOIN loops reply_loop ON reply_loop.id = reply.loop_id
LEFT JOIN turns reply_turn ON reply_turn.id = reply.turn_id
WHERE w.origin = 'model'
  AND w.archived_at IS NULL
  AND ($session_id IS NULL OR w.id = $session_id)
  AND (w.workspace_id = $workspace_id
       OR ($workspace_id IS NULL AND (SELECT ws.archived_at FROM workspaces ws WHERE ws.id = w.workspace_id) IS NULL));

-- PREP: overview_reply_words
-- {§application-session-observation}: the words of the replies the overview holds, $ids a JSON array of their log rows.
SELECT le.id,
       CASE WHEN json_valid(le.tx) THEN
            COALESCE(json_extract(le.tx, '$.body.raw'),
                     CASE WHEN json_type(le.tx, '$.body') = 'text' THEN json_extract(le.tx, '$.body') END)
       END AS words
FROM log_entries le
WHERE le.id IN (SELECT value FROM json_each($ids));

-- PREP: overview_opening_words
-- {§application-session-observation}: the opening prompt of the held places' first work loop, $ids a JSON array of session ids.
SELECT l.session_id AS sessionId, l.prompt AS words
FROM work_loops l
WHERE l.session_id IN (SELECT value FROM json_each($ids))
  AND l.sequence = (SELECT MIN(l2.sequence) FROM work_loops l2 WHERE l2.session_id = l.session_id);

-- PREP: overview_reply_by_entry
-- {§application-session-observation} {§notifications}: projects a committed log row as a finished reply when it completed a message (200 or 499).
SELECT le.id, le.at AS replyAt,
       COALESCE(
           CASE WHEN le.mimetype_rx = 'application/json' AND json_valid(le.rx)
                THEN json_extract(le.rx, '$.completion') END,
           (SELECT MIN(c.status) FROM message_completions c WHERE c.response_id = le.id)
       ) AS replyCompletion,
       printf('%d/%d/%d', reply_loop.sequence, reply_turn.sequence, le.sequence) AS replyCoordinate,
       CASE WHEN json_valid(le.tx) THEN
            COALESCE(json_extract(le.tx, '$.body.raw'),
                     CASE WHEN json_type(le.tx, '$.body') = 'text' THEN json_extract(le.tx, '$.body') END)
       END AS words
FROM log_entries le
JOIN sessions s ON s.id = le.session_id
JOIN loops reply_loop ON reply_loop.id = le.loop_id
JOIN turns reply_turn ON reply_turn.id = le.turn_id
WHERE le.id = $entry_id
  AND s.origin = 'model'
  AND le.inherited_history = 0
  AND le.origin = 'model'
  AND le.op IN ('send', 'done', 'fail')
  AND le.state = 'resolved'
  AND le.status_rx < 400;
