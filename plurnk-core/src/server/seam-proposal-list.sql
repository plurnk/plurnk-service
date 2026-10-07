-- PREP: proposal_list_pending
-- {§proposal-list} — durable candidates in a workspace. ProposalLifecycle intersects
-- them with its live resolution owners before projecting a stopped world; neither
-- Daemon nor an interface module reconstructs authority from this persistence shape.
SELECT le.id AS logEntryId, r.workspace_id AS workspaceId,
    le.worker_id AS workerId, le.loop_id AS loopId, le.turn_id AS turnId,
    le.op, le.signal, le.scheme, le.hostname, le.port, le.pathname, le.query,
    le.rx, le.attrs, r.owner, o.tools AS owner_tools, t.kind AS turn_kind
FROM log_entries le
JOIN workers r ON r.id = le.worker_id
JOIN worker_owners o ON o.workspace_id = r.workspace_id AND o.address = r.owner
JOIN turns t ON t.id = le.turn_id
WHERE r.workspace_id = $workspace_id AND le.state = 'proposed'
ORDER BY le.id;

-- PREP: proposal_get_pending
-- Same durable input as proposal_list_pending, selected by proposal identity for
-- the live path. Both paths enter ProposalLifecycle's one projection function.
SELECT le.id AS logEntryId, r.workspace_id AS workspaceId,
    le.worker_id AS workerId, le.loop_id AS loopId, le.turn_id AS turnId,
    le.op, le.signal, le.scheme, le.hostname, le.port, le.pathname, le.query,
    le.rx, le.attrs, r.owner, o.tools AS owner_tools, t.kind AS turn_kind
FROM log_entries le
JOIN workers r ON r.id = le.worker_id
JOIN worker_owners o ON o.workspace_id = r.workspace_id AND o.address = r.owner
JOIN turns t ON t.id = le.turn_id
WHERE le.id = $log_entry_id AND le.state = 'proposed';
