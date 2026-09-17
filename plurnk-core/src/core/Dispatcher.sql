-- Dispatcher: whole-program observation boundaries and the turn's own failures.

-- PREP: engine_log_selection_high_water
-- An admitted program resolves log curation against the event journal as it
-- existed on entry. Later statements may observe earlier effects, but a broad
-- KILL cannot capture operation rows the same program is still emitting.
SELECT COALESCE(MAX(id), 0) AS max_id
FROM log_entries
WHERE worker_id = $worker_id;

-- PREP: engine_turn_packet_boundaries
-- {§send-premature-terminate}: executed operations, independent of log curation.
-- NULL op identifies actionless evidence, not a dispatched statement.
SELECT op, tx FROM log_entries
WHERE turn_id = $turn_id
  AND origin = 'model'
  AND source IS NULL
  AND inherited_history = 0
  AND op NOT IN ('SEND', 'NOTE', 'WAIT')
ORDER BY sequence, id;

-- PREP: engine_worker_has_undelivered_stream_term
-- A stream may finish between its EXEC and a same-turn SEND. It is then no longer
-- live, but its terminal outcome has not crossed the pre-turn observation boundary:
-- one or more selected channel publication rows remain nonterminal. Treat that
-- closed result like a same-turn retrieval or child termination so an empty
-- join cannot conclude over unseen work.
-- Completion is information independently of payload: an empty success and especially
-- an empty failure must receive the same terminal observation as a non-empty stream.
-- Success and failure both require observation.
SELECT DISTINCT s.close_status AS closeStatus
FROM subscriptions s
JOIN subscription_publications sp ON sp.subscription_id = s.id
WHERE s.worker_id = $worker_id
  AND s.closed_at IS NOT NULL
  AND sp.terminal_published = 0;

-- PREP: engine_turn_failures
-- {§send-premature-terminate}: model-authored failures require observation before
-- ordinary completion. This includes bounded grammar failures in admitted programs;
-- actionless runtime evidence is handled by its owning recovery rail.
SELECT id FROM log_entries
WHERE turn_id = $turn_id
  AND origin = 'model'
  AND status_rx >= 400
  AND (op != 'error' OR source = 'grammar');

-- PREP: engine_worker_has_undelivered_child_term
-- A child conclusion newer than the parent's observation cursor is complete but
-- not delivered. This is the same durable boundary the next packet consumes,
-- not a second timestamp race. {§send-undelivered-child-term}
SELECT 1 AS pending
FROM ambient_events ae
JOIN workers parent ON parent.id = $worker_id
WHERE ae.workspace_id = parent.workspace_id
  AND ae.kind IN ('loop_termination', 'reply')
  AND ae.recipient_worker_id = parent.id
  AND ae.id > COALESCE(parent.ambient_event_cursor, 0)
LIMIT 1;
