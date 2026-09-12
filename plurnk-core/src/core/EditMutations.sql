-- EditMutations: what an EDIT verifies a pasted anchor block against.

-- PREP: edit_published_reads
-- {§edit-batch-merges}: a paste from an older READ verifies against the anchors that READ actually
-- published — this worker's still-active READ receipts for the same anchor identity, oldest first.
-- The selection is the database's: no whole-log render, no JSON parsed in the process.
SELECT COALESCE(json_extract(le.rx, '$.startLine'), 1) AS start_line,
       json_extract(le.rx, '$.lineAnchors') AS anchors
FROM active_log_entries le
WHERE le.worker_id = $worker_id
  AND le.op = 'READ' AND le.status_rx = 200
  AND json_valid(le.rx)
  AND json_extract(le.rx, '$.lineAnchorIdentity') = $identity
  AND json_type(le.rx, '$.lineAnchors') = 'array'
ORDER BY le.id;
