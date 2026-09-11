-- PREP: turn_source_record
INSERT INTO turn_sources (turn_id, kind, content, model_call_id)
SELECT t.id, $kind, $content, $model_call_id
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
FROM turns t JOIN loops l ON l.id = t.loop_id
LEFT JOIN turn_sources s ON s.turn_id = t.id AND s.kind = $kind
WHERE l.worker_id = $worker_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq;

-- PREP: turn_source_candidates
SELECT s.turn_id, s.kind, '/' || l.sequence || '/' || t.sequence AS pathname,
       s.content, s.deep_hash
FROM turn_sources s JOIN turns t ON t.id = s.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND s.kind = $kind
ORDER BY l.sequence, t.sequence;

-- PREP: turn_source_derivations
SELECT s.turn_id, s.kind, '/' || l.sequence || '/' || t.sequence AS pathname,
       s.content, s.deep_hash
FROM turn_sources s JOIN turns t ON t.id = s.turn_id
JOIN loops l ON l.id = t.loop_id JOIN workers w ON w.id = l.worker_id
WHERE w.workspace_id = $workspace_id;

-- PREP: turn_source_attach_derivation
UPDATE turn_sources SET deep_hash = $deep_hash
WHERE turn_id = $turn_id AND kind = $kind;
