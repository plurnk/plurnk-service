-- PREP: proposal_list_pending
-- §proposal-list — every stopped-world proposal in the session (state='proposed'): file edits,
-- MCP auths, [300] questions. The ruling's mandatory companion ({§proposal-timeout-cancels}
-- ships indefinite): a world that can stay stopped for days MUST be discoverable by a
-- reconnecting client, or granted patience reads as a mystery hang.
SELECT le.id AS logEntryId, le.run_id AS runId, le.loop_id AS loopId, le.turn_id AS turnId,
    le.op, le.suffix, le.scheme, le.pathname, le.tx, le.attrs, le.at,
    l.flags AS loop_flags
FROM log_entries le
JOIN runs r ON r.id = le.run_id
JOIN loops l ON l.id = le.loop_id
WHERE r.session_id = $session_id AND le.state = 'proposed'
ORDER BY le.id;
