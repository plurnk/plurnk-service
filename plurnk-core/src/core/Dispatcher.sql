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

-- PREP: engine_session_has_undelivered_stream_term
-- A stream may finish between its exec and a same-turn send. It is then no longer
-- live, but its terminal outcome has not crossed the pre-turn observation boundary:
-- one or more selected channel publication rows remain nonterminal. Treat that
-- closed result like a same-turn retrieval or child termination so an empty
-- join cannot conclude over unseen work.
-- Completion is information independently of payload: an empty success and especially
-- an empty failure must receive the same terminal observation as a non-empty stream.
-- Success and failure both require observation.
SELECT DISTINCT status AS closeStatus
FROM unobserved_session_completions
WHERE session_id = $session_id AND kind = 'stream';

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

-- PREP: engine_session_has_undelivered_child_term
-- A child conclusion newer than the parent's observation cursor is complete but
-- not delivered. This is the same durable boundary the next packet consumes,
-- not a second timestamp race. {§loop-completion}
SELECT 1 AS pending FROM unobserved_session_completions
WHERE session_id = $session_id AND kind = 'ambient'
LIMIT 1;

-- PREP: engine_session_undelivered_child_count
SELECT COUNT(*) AS count FROM unobserved_session_completions
WHERE session_id = $session_id AND kind = 'ambient';
