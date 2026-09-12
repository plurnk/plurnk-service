-- Process triggers of the ambient activity feed: what a worker's siblings and parent
-- observe of it. {§db-process-triggers}

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
