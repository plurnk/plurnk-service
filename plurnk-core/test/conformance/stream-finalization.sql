-- {§subscription-finalization}: fault and assertions for the packed client/service journey.
-- This directory is not loaded by the daemon or shipped in its tarball.

-- EXEC: test_fail_stream_close
CREATE TRIGGER installed_journey_close_failure
BEFORE UPDATE OF closed_at ON subscriptions
WHEN NEW.closed_at IS NOT NULL
    AND NEW.worker_id IN (SELECT id FROM workers WHERE name = 'Recovery_Worker')
BEGIN
    SELECT RAISE(ABORT, 'installed-journey durable close unavailable');
END;

-- EXEC: test_restore_stream_close
DROP TRIGGER IF EXISTS installed_journey_close_failure;

-- PREP: test_stream_recovery_state
SELECT s.id, s.closed_at, s.close_status, s.close_result, e.pathname, l.status AS loop_status
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
JOIN workers w ON w.id = s.worker_id
JOIN loops l ON l.worker_id = w.id
WHERE w.name = 'Recovery_Worker'
ORDER BY l.id DESC
LIMIT 1;
