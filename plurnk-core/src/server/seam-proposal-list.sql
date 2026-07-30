-- PREP: proposal_list_pending
-- §proposal-list — every stopped-world proposal in the workspace (state='proposed'): file edits,
-- [300] questions. The ruling's mandatory companion ({§proposal-timeout-cancels}
-- ships indefinite): a world that can stay stopped for days MUST be discoverable by a
-- reconnecting client, or granted patience reads as a mystery hang.
SELECT le.id AS logEntryId, le.worker_id AS workerId, le.loop_id AS loopId, le.turn_id AS turnId,
    le.op, le.suffix, le.scheme, le.pathname, le.tx, le.attrs, le.at,
    l.flags AS loop_flags
FROM log_entries le
JOIN workers r ON r.id = le.worker_id
JOIN loops l ON l.id = le.loop_id
WHERE r.workspace_id = $workspace_id AND le.state = 'proposed'
ORDER BY le.id;
