-- ApplicationPort readSessionOverview queries. SPEC {§methods-session-overview}.

-- PREP: overview_places
-- {§application-session-overview}: the places in scope, each with its loops' observations for its lifecycle
-- ({§application-session-observation}) and its latest finished reply ({§session-finished-reply}), without the reply's words.
-- {§place-hiding} A hidden session is out of scope, and in the daemon's scope so is every session of a hidden workspace.
SELECT w.id, w.workspace_id AS workspaceId, w.name, w.parent_session_id AS parentSessionId,
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
LEFT JOIN log_entries reply ON reply.id = (
    SELECT le.id FROM log_entries le
    WHERE le.session_id = w.id
      AND le.op = 'SEND' AND le.origin = 'model' AND le.inherited_history = 0
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
  AND w.hidden_at IS NULL
  AND (w.workspace_id = $workspace_id
       OR ($workspace_id IS NULL AND (SELECT ws.hidden_at FROM workspaces ws WHERE ws.id = w.workspace_id) IS NULL));

-- PREP: overview_reply_words
-- {§list-excerpt}: the words of the replies the overview holds, $ids a JSON array of their log rows.
SELECT le.id,
       CASE WHEN json_valid(le.tx) THEN
            COALESCE(json_extract(le.tx, '$.body.raw'),
                     CASE WHEN json_type(le.tx, '$.body') = 'text' THEN json_extract(le.tx, '$.body') END)
       END AS words
FROM log_entries le
WHERE le.id IN (SELECT value FROM json_each($ids));

-- PREP: overview_workspaces
-- {§application-session-overview}: the workspaces the held places belong to, $ids a JSON array of their ids.
SELECT id, name, project_root AS projectRoot
FROM workspaces
WHERE id IN (SELECT value FROM json_each($ids))
ORDER BY id;
