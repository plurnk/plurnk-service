-- Dispatcher: whole-program observation boundaries and the turn's own failures.

-- PREP: engine_log_selection_high_water
-- An admitted program resolves log curation against the event journal as it
-- existed on entry. Later statements may observe earlier effects, but a broad
-- kill cannot capture operation rows the same program is still emitting.
SELECT COALESCE(MAX(id), 0) AS max_id
FROM log_entries
WHERE session_id = $session_id;

-- PREP: engine_turn_packet_boundaries
-- {§loop-completion}: executed operations, independent of log curation.
-- NULL op identifies actionless evidence, not a dispatched statement.
SELECT op, tx, CASE WHEN json_valid(attrs) THEN json_extract(attrs, '$.stream') END AS stream
FROM log_entries
WHERE turn_id = $turn_id
  AND origin = 'model'
  AND source IS NULL
  AND inherited_history = 0
  AND op NOT IN ('send', 'done', 'fail', 'note', 'wait')
ORDER BY sequence, id;

-- PREP: engine_session_undelivered_stream_terms
SELECT DISTINCT s.id AS subscriptionId, s.close_status AS closeStatus,
       e.scheme, e.authority, e.pathname
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
JOIN subscription_publications sp ON sp.subscription_id = s.id
WHERE s.session_id = $session_id AND s.closed_at IS NOT NULL AND sp.terminal_published = 0;

-- PREP: engine_turn_failure_count
-- {§loop-completion}: model-authored failures require observation before
-- ordinary completion. This includes bounded grammar failures in admitted programs;
-- actionless runtime evidence is handled by its owning recovery rail.
SELECT COUNT(*) AS count FROM log_entries
WHERE turn_id = $turn_id
  AND origin = 'model'
  AND status_rx >= 400
  AND (op != 'error' OR source = 'grammar');

-- PREP: engine_session_undelivered_child_count
-- {§loop-completion}: child conclusions newer than the parent's observation cursor.
SELECT COUNT(*) AS count FROM unobserved_session_completions
WHERE session_id = $session_id AND kind = 'ambient';
