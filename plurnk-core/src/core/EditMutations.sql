-- EditMutations: what an edit verifies a pasted anchor block against.

-- PREP: edit_published_reads
-- {§op-methods-op-dispatch}: a paste from an older read verifies against the anchors that read actually
-- published — this session's still-active read receipts for the same anchor identity, oldest first.
-- The selection is the database's: no whole-log render, no JSON parsed in the process.
SELECT COALESCE(json_extract(le.rx, '$.startLine'), 1) AS start_line,
       json_extract(le.rx, '$.lineAnchors') AS anchors
FROM active_log_entries le
WHERE le.session_id = $session_id
  AND le.op = 'read' AND le.status_rx = 200
  AND json_valid(le.rx)
  AND json_extract(le.rx, '$.lineAnchorIdentity') = $identity
  AND json_type(le.rx, '$.lineAnchors') = 'array'
ORDER BY le.id;
