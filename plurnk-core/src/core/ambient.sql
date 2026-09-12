-- The ambient activity feed: what a worker's siblings and parent observe of it. The process
-- triggers that publish it ({§db-process-triggers}) and the cursor statements TurnMaterialization
-- pulls it with.

-- INIT: ambient_child_wake_revision
DROP TRIGGER IF EXISTS ambient_child_wake_revision;
CREATE TRIGGER ambient_child_wake_revision
AFTER INSERT ON ambient_events
WHEN NEW.kind = 'loop_termination'
BEGIN
    UPDATE workers SET wake_revision = wake_revision + 1
    WHERE id = NEW.target_parent_worker_id;
END;

-- INIT: workers_capture_ambient_baseline
-- A worker begins after the history that predates its existence. This trigger
-- runs in the worker INSERT statement, so an occurrence is either in the
-- baseline or after it. Fork INSERTs supply their own cursor/boundary and skip
-- this ordinary-worker baseline. {§env-delta-log-pull}
DROP TRIGGER IF EXISTS workers_capture_ambient_baseline;
CREATE TRIGGER workers_capture_ambient_baseline
AFTER INSERT ON workers
WHEN NEW.ambient_event_cursor IS NULL
BEGIN
    UPDATE workers
    SET ambient_event_cursor = COALESCE((
        SELECT MAX(ae.id) FROM ambient_events ae WHERE ae.workspace_id = NEW.workspace_id
    ), 0)
    WHERE id = NEW.id;
END;

-- INIT: loops_append_ambient_event
-- A child terminal transition is an occurrence addressed only to its direct
-- parent. Directly inserted fork history never crosses this transition and
-- therefore cannot fabricate a new conclusion event. The occurrence carries no
-- target: it is a message from the child, and a commons-shaped
-- `worker:///name` would name an entry the child never wrote (#567).
DROP TRIGGER IF EXISTS loops_append_ambient_event;
CREATE TRIGGER loops_append_ambient_event
AFTER UPDATE OF status ON loops
WHEN NEW.status IN (200, 413, 429, 499, 500, 504, 508) AND OLD.status NOT IN (200, 413, 429, 499, 500, 504, 508)
BEGIN
    INSERT INTO ambient_events (
        workspace_id, producer_worker_id, target_parent_worker_id,
        workspace_broadcast, kind, source_record_id, source,
        op, scheme, pathname,
        tx, mimetype_tx, rx, mimetype_rx, status_rx, state, terminated_by
    )
    SELECT w.workspace_id, NEW.worker_id, w.parent_worker_id,
           0, 'loop_termination', NEW.id, NULL,
           'SEND', NULL, NULL,
           '', 'text/plain', NEW.terminal_result, 'application/json',
           json_extract(NEW.terminal_result, '$.status'), 'resolved', NEW.terminated_by
    FROM workers w
    WHERE w.id = NEW.worker_id
      AND w.parent_worker_id IS NOT NULL
      -- {§env-delta-child-termination}: runtime administrative work is not a
      -- delegated conclusion. A spawn failing before its first turn still is.
      AND (
          NOT EXISTS (SELECT 1 FROM turns t WHERE t.loop_id = NEW.id)
          OR EXISTS (
              SELECT 1
              FROM turns t
              WHERE t.loop_id = NEW.id
                AND NOT (t.producer = '_plurnk' AND t.kind IN ('operation', 'maintenance'))
          )
      );
END;

-- INIT: log_entries_append_ambient_event_insert
-- Every final op-bearing child row is parent activity. A successful operation
-- whose landed effects touch worker:/// additionally acquires the workspace
-- audience. Observer rows and copied fork history cannot republish themselves.
DROP TRIGGER IF EXISTS log_entries_append_ambient_event_insert;
CREATE TRIGGER log_entries_append_ambient_event_insert
AFTER INSERT ON log_entries
WHEN NEW.state != 'proposed'
BEGIN
    INSERT INTO ambient_events (
        workspace_id, producer_worker_id, target_parent_worker_id,
        workspace_broadcast, kind, source_record_id, at, source,
        op, signal,
        scheme, username, password, hostname, port, pathname, query, fragment,
        line_marker, tx, mimetype_tx, rx, mimetype_rx, status_rx,
        state, outcome, attrs
    )
    SELECT workspace_id, producer_worker_id, target_parent_worker_id,
           workspace_broadcast, 'activity', source_record_id, at, source,
           op, signal,
           scheme, username, password, hostname, port, pathname, query, fragment,
           line_marker, tx, mimetype_tx, rx, mimetype_rx, status_rx,
           state, outcome, attrs
    FROM ambient_activity_candidates
    WHERE source_record_id = NEW.id;

    UPDATE log_entries
    SET ambient_event_id = (
        SELECT id FROM ambient_events
        WHERE producer_worker_id = NEW.worker_id
          AND kind = 'activity'
          AND source_record_id = NEW.id
    )
    WHERE id = NEW.id
      AND EXISTS (
          SELECT 1 FROM ambient_events
          WHERE producer_worker_id = NEW.worker_id
            AND kind = 'activity'
            AND source_record_id = NEW.id
      );
END;

-- INIT: log_entries_append_ambient_event_resolve
-- A proposed operation becomes activity only when its lifecycle settles.
DROP TRIGGER IF EXISTS log_entries_append_ambient_event_resolve;
CREATE TRIGGER log_entries_append_ambient_event_resolve
AFTER UPDATE OF state, status_rx, rx, outcome ON log_entries
WHEN OLD.state = 'proposed' AND NEW.state != 'proposed'
BEGIN
    INSERT INTO ambient_events (
        workspace_id, producer_worker_id, target_parent_worker_id,
        workspace_broadcast, kind, source_record_id, at, source,
        op, signal,
        scheme, username, password, hostname, port, pathname, query, fragment,
        line_marker, tx, mimetype_tx, rx, mimetype_rx, status_rx,
        state, outcome, attrs
    )
    SELECT workspace_id, producer_worker_id, target_parent_worker_id,
           workspace_broadcast, 'activity', source_record_id, at, source,
           op, signal,
           scheme, username, password, hostname, port, pathname, query, fragment,
           line_marker, tx, mimetype_tx, rx, mimetype_rx, status_rx,
           state, outcome, attrs
    FROM ambient_activity_candidates
    WHERE source_record_id = NEW.id;

    UPDATE log_entries
    SET ambient_event_id = (
        SELECT id FROM ambient_events
        WHERE producer_worker_id = NEW.worker_id
          AND kind = 'activity'
          AND source_record_id = NEW.id
    )
    WHERE id = NEW.id
      AND EXISTS (
          SELECT 1 FROM ambient_events
          WHERE producer_worker_id = NEW.worker_id
            AND kind = 'activity'
            AND source_record_id = NEW.id
      );
END;

-- PREP: engine_initialize_ambient_cursor
-- Worker creation owns the baseline, and fork creation owns its inherited
-- cursor/boundary. Packet assembly merely verifies that durable invariant.
SELECT ambient_event_cursor
FROM workers
WHERE id = $worker_id
  AND workspace_id = $workspace_id;

-- PREP: engine_pull_ambient_events
-- One SQLite snapshot captures both ends of the closed observation window.
-- The LEFT JOIN returns the boundary even when the window contains no event.
WITH observation AS (
    SELECT w.ambient_event_cursor AS cursor,
           w.parent_worker_id,
           w.fork_event_boundary,
           COALESCE(
               (SELECT MAX(ae.id) FROM ambient_events ae WHERE ae.workspace_id = $workspace_id),
               w.ambient_event_cursor,
               0
           ) AS boundary
    FROM workers w
    WHERE w.id = $worker_id AND w.workspace_id = $workspace_id
)
SELECT o.cursor, o.boundary,
       ae.id AS event_id, ae.producer_worker_id, producer.name AS producer_worker_name,
       ae.kind, ae.source, ae.at,
       ae.op, ae.signal,
       ae.scheme, ae.username, ae.password, ae.hostname, ae.port,
       ae.pathname, ae.query, ae.fragment, ae.line_marker,
       ae.tx, ae.mimetype_tx, ae.rx, ae.mimetype_rx,
       ae.state, ae.outcome, ae.attrs,
       ae.status_rx, ae.terminated_by
FROM observation o
LEFT JOIN ambient_events ae
  ON ae.workspace_id = $workspace_id
 AND ae.id > o.cursor
 AND ae.id <= o.boundary
 AND ae.producer_worker_id != $worker_id
 AND (
     ae.target_parent_worker_id = $worker_id
     OR ae.workspace_broadcast = 1
     OR (
         o.fork_event_boundary IS NOT NULL
         AND ae.target_parent_worker_id = o.parent_worker_id
         AND ae.id <= o.fork_event_boundary
     )
 )
LEFT JOIN workers producer ON producer.id = ae.producer_worker_id
ORDER BY ae.id;

-- PREP: engine_insert_ambient_delta
-- Materialize one occurrence into the observer's self-contained log. The
-- targeted conflict rule makes crash replay idempotent without swallowing any
-- unrelated sequence, FK, or shape violation.
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, at, origin, source, ambient_event_id,
    op, signal,
    scheme, username, password, hostname, port, pathname, query, fragment,
    lineMarker, tx, mimetype_tx,
    rx, mimetype_rx, status_rx, weight, state, outcome, initial_folded, attrs
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, $at, '_plurnk', $source, $event_id,
    $op, $signal,
    $scheme, $username, $password, $hostname, $port, $pathname, $query, $fragment,
    $line_marker, $tx, $mimetype_tx,
    $rx, $mimetype_rx, $status, $weight, $state, $outcome, $folded, $attrs
)
ON CONFLICT(worker_id, ambient_event_id) WHERE ambient_event_id IS NOT NULL DO NOTHING
RETURNING id;

-- PREP: engine_ambient_delta_id
-- Crash replay may find the observation row already inserted but its copied
-- classifications incomplete. Resolve that row so idempotent tag writes can finish.
SELECT id FROM log_entries WHERE worker_id = $worker_id AND ambient_event_id = $event_id;

-- PREP: engine_advance_ambient_cursor
-- Advance only from the snapshot that was actually materialized. A concurrent
-- pull winning the CAS is safe; a loser replays idempotently on its next turn.
UPDATE workers
SET ambient_event_cursor = $boundary
WHERE id = $worker_id
  AND workspace_id = $workspace_id
  AND ambient_event_cursor IS $cursor
  AND $boundary >= ambient_event_cursor
RETURNING ambient_event_cursor;
