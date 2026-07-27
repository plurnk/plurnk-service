-- Process-bound lifecycle recovery. These statements run once at daemon boot,
-- before client transports open. Each is idempotent so a crash during recovery
-- can be followed by the same sequence.

-- PREP: recovery_fail_active_loops
-- 102 is a claim held by a process-local drain. After restart that owner is gone;
-- replaying its provider turn could duplicate effects whose commit boundary is unknown.
UPDATE loops
SET status = 500,
    terminal_message = 'daemon restarted while this loop was active'
WHERE status = 102;

-- PREP: recovery_error_orphan_subscription_channels
-- Every open subscription belonged to a callable in the prior process. Mark its
-- active content terminal before closing the durable row, so an interruption
-- between these statements remains recoverable on the next boot.
UPDATE entry_channels
SET state = 'errored'
WHERE state = 'active'
  AND entry_id IN (
      SELECT entry_id FROM subscriptions WHERE closed_at IS NULL
  );

-- PREP: recovery_fail_orphan_subscriptions
UPDATE subscriptions
SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    close_status = 500,
    close_result = json_object(
        'status', 500,
        'problem', json_object(
            'type', 'https://problems.plurnk.dev/lifecycle/recovery/owner-vanished',
            'title', 'Owner vanished',
            'status', 500,
            'detail', 'The daemon restarted while this stream was active; its process-local owner no longer exists.'
        )
    )
WHERE closed_at IS NULL;

-- PREP: recovery_resume_unblocked_parks
-- A 202 continuation is valid only while its worker still holds an open stream
-- or a child whose latest loop is live. Requeue every now-satisfied park in one
-- pass; child completion propagates the same transition to ancestors later.
UPDATE loops
SET status = 100
WHERE status = 202
  AND NOT EXISTS (
      SELECT 1
      FROM subscriptions s
      WHERE s.worker_id = loops.worker_id AND s.closed_at IS NULL
  )
  AND NOT EXISTS (
      SELECT 1
      FROM workers child
      JOIN loops child_loop ON child_loop.id = (
          SELECT id
          FROM loops latest
          WHERE latest.worker_id = child.id
          ORDER BY latest.sequence DESC, latest.id DESC
          LIMIT 1
      )
      WHERE child.parent_worker_id = loops.worker_id
        AND child_loop.status IN (100, 102, 202)
  );

-- PREP: recovery_queued_workers
SELECT DISTINCT w.id AS worker_id, w.workspace_id
FROM workers w
JOIN loops l ON l.worker_id = w.id
WHERE l.status = 100
ORDER BY w.id;

-- PREP: recovery_parked_workers
SELECT DISTINCT w.id AS worker_id, w.workspace_id
FROM workers w
JOIN loops l ON l.worker_id = w.id
WHERE l.status = 202
ORDER BY w.id;
