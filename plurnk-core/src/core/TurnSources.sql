-- PREP: turn_source_record
INSERT INTO turn_sources (turn_id, kind, sequence, content, model_call_id)
SELECT t.id, $kind, $sequence, $content, $model_call_id
FROM turns t
WHERE t.id = $turn_id AND t.completed_at IS NULL
  AND ($model_call_id IS NULL OR EXISTS (
      SELECT 1 FROM inference_calls c
      WHERE c.id = $model_call_id AND c.turn_id = t.id
        AND c.kind = 'emission' AND c.state = 'response'
  ))
RETURNING turn_id;

-- PREP: turn_source_read
-- {§turn-source-resources} The turn decides existence, the source decides content: no row is
-- a turn that does not exist (404); a NULL content is an existing turn with no source of this
-- kind, which reads empty rather than absent.
SELECT s.content
FROM turns t JOIN loops l ON l.id = t.loop_id JOIN workers w ON w.id = l.worker_id
LEFT JOIN turn_sources s ON s.turn_id = t.id AND s.kind = $kind AND s.sequence = $sequence
WHERE w.workspace_id = $workspace_id AND w.name = $worker_name
  AND l.sequence = $loop_seq AND t.sequence = $turn_seq
  AND ($kind != 'note' OR s.turn_id IS NOT NULL);

-- PREP: turn_source_loop_answer
-- {§loop-answer} A loop's answer is the latest reply its own loop gave to its originating message
-- (ordinal 1): a prose conclusion or a SEND that targeted it. The loop's status says whether an
-- absent answer is still to come.
SELECT l.status, l.terminal_result, l.terminated_by,
       (SELECT r.content
        FROM log_responses r, json_each(r.rx, '$.answers') a
        WHERE r.loop_id = l.id AND a.value = m.path
        ORDER BY r.id DESC LIMIT 1) AS answer
FROM loops l JOIN workers w ON w.id = l.worker_id
LEFT JOIN message_sources m ON m.loop_id = l.id AND m.ordinal = 1
WHERE w.workspace_id = $workspace_id AND w.name = $worker_name AND l.sequence = $loop_seq;

-- PREP: turn_source_candidates
-- {§loop-answer}: `ops://<worker>/<loop>` is a resource of its own beside each turn's emission, so
-- a FIND over a worker's programs also finds what its loops said.
SELECT s.turn_id, s.kind, s.sequence, w.name AS authority,
       '/' || l.sequence || '/' || t.sequence || CASE WHEN s.kind = 'note' THEN '/' || s.sequence ELSE '' END AS pathname,
       s.content, s.deep_hash
FROM turn_sources s JOIN turns t ON t.id = s.turn_id
JOIN loops l ON l.id = t.loop_id JOIN workers w ON w.id = l.worker_id
WHERE w.workspace_id = $workspace_id AND ($worker_name IS NULL OR w.name = $worker_name) AND s.kind = $kind
UNION ALL
SELECT NULL AS turn_id, 'ops' AS kind, 0 AS sequence, w.name AS authority,
       '/' || l.sequence AS pathname,
       COALESCE((SELECT r.content
                 FROM log_responses r, json_each(r.rx, '$.answers') a
                 WHERE r.loop_id = l.id AND a.value = m.path
                 ORDER BY r.id DESC LIMIT 1),
                json_extract(l.terminal_result, '$.content'), '') AS content,
       NULL AS deep_hash
FROM loops l JOIN workers w ON w.id = l.worker_id
LEFT JOIN message_sources m ON m.loop_id = l.id AND m.ordinal = 1
WHERE $kind = 'ops' AND w.workspace_id = $workspace_id AND ($worker_name IS NULL OR w.name = $worker_name)
ORDER BY authority, pathname;

-- PREP: turn_source_derivations
SELECT s.turn_id, s.kind, s.sequence,
       '/' || l.sequence || '/' || t.sequence || CASE WHEN s.kind = 'note' THEN '/' || s.sequence ELSE '' END AS pathname,
       s.content, s.deep_hash
FROM turn_sources s JOIN turns t ON t.id = s.turn_id
JOIN loops l ON l.id = t.loop_id JOIN workers w ON w.id = l.worker_id
WHERE w.workspace_id = $workspace_id;

-- PREP: turn_source_attach_derivation
UPDATE turn_sources SET deep_hash = $deep_hash
WHERE turn_id = $turn_id AND kind = $kind AND sequence = $sequence;
