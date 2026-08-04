-- PREP: proposal_list_pending
-- {§proposal-list} — durable candidates in a workspace. ProposalLifecycle intersects
-- them with its live resolution owners before projecting a stopped world; neither
-- Daemon nor an interface module reconstructs authority from this persistence shape.
SELECT le.id AS logEntryId, r.workspace_id AS workspaceId,
    le.worker_id AS workerId, le.loop_id AS loopId, le.turn_id AS turnId,
    le.op, le.signal, le.scheme, le.pathname, le.rx, le.attrs, l.flags AS loop_flags
FROM log_entries le
JOIN workers r ON r.id = le.worker_id
JOIN loops l ON l.id = le.loop_id
WHERE r.workspace_id = $workspace_id AND le.state = 'proposed'
ORDER BY le.id;

-- PREP: proposal_get_pending
-- Same durable input as proposal_list_pending, selected by proposal identity for
-- the live path. Both paths enter ProposalLifecycle's one projection function.
SELECT le.id AS logEntryId, r.workspace_id AS workspaceId,
    le.worker_id AS workerId, le.loop_id AS loopId, le.turn_id AS turnId,
    le.op, le.signal, le.scheme, le.pathname, le.rx, le.attrs, l.flags AS loop_flags
FROM log_entries le
JOIN workers r ON r.id = le.worker_id
JOIN loops l ON l.id = le.loop_id
WHERE le.id = $log_entry_id AND le.state = 'proposed';
