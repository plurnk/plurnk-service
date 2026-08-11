-- Process-bound lifecycle recovery. These statements run once at daemon boot,
-- before client transports open. Each is idempotent so a crash during recovery
-- can be followed by the same sequence.

-- PREP: recovery_fail_active_loops
-- 102 is a claim held by a process-local drain. After restart that owner is gone;
-- replaying its provider turn could duplicate effects whose commit boundary is unknown.
UPDATE loops
SET status = 500,
    terminal_result = json_object(
        'status', 500,
        'problem', json_object(
            'type', 'https://problems.plurnk.dev/lifecycle/recovery/owner-vanished',
            'title', 'Owner vanished',
            'status', 500,
            'detail', 'The daemon restarted while this loop was active; its process-local owner no longer exists.',
            'instance', 'loop:///' || id
        )
    )
WHERE status = 102;

-- PREP: recovery_settle_open_provider_requests
-- A physical request identity was opened immediately before I/O, so a crash can
-- leave its outcome and provider evidence unknowable. Preserve the occurrence
-- and settle that uncertainty explicitly before closing its logical attempt.
UPDATE provider_requests
SET state = 'settled',
    outcome = 'error',
    cost_kind = 'unknown',
    cost_reason = 'daemon restarted before provider request evidence was durably observed',
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state = 'pending'
  AND EXISTS (
      SELECT 1
      FROM turn_attempts a
      JOIN turns t ON t.id = a.turn_id
      JOIN loops l ON l.id = t.loop_id
      WHERE a.id = provider_requests.turn_attempt_id
        AND l.terminated_at IS NOT NULL
  );

-- PREP: recovery_fail_open_provider_attempts
-- The process-local emission owner vanished. Physical requests have already
-- been settled above, preserving unknown evidence without fabricating zero use.
UPDATE turn_attempts
SET state = 'error',
    failure = json_object(
        'status', 500,
        'problem', json_object(
            'type', 'https://problems.plurnk.dev/lifecycle/recovery/owner-vanished',
            'title', 'Owner vanished',
            'status', 500,
            'detail', 'The daemon restarted before this provider response was durably observed; whether the provider completed the call is unknown.'
        )
    ),
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state = 'pending'
  AND EXISTS (
      SELECT 1
      FROM turns t
      JOIN loops l ON l.id = t.loop_id
      WHERE t.id = turn_attempts.turn_id
        AND l.terminated_at IS NOT NULL
  );

-- PREP: recovery_fail_ownerless_proposals
-- {§worker-lifecycle-restart-recovery} Every proposed row depended on a
-- process-local resolution waiter. At boot that owner is necessarily gone, so
-- terminalize the occurrence before {§proposal-list} can open to clients.
UPDATE log_entries
SET state = 'failed',
    outcome = 'owner_vanished',
    status_rx = 500,
    rx = json_object(
        'status', 500,
        'problem', json_object(
            'type', 'https://problems.plurnk.dev/lifecycle/recovery/owner-vanished',
            'title', 'Owner vanished',
            'status', 500,
            'detail', 'The daemon restarted while this proposal was pending; its process-local owner no longer exists.',
            'instance', printf(
                'log:///%d/%d/%d/%s',
                (SELECT sequence FROM loops WHERE id = log_entries.loop_id),
                (SELECT sequence FROM turns WHERE id = log_entries.turn_id),
                sequence,
                op
            )
        )
    ),
    deep_hash = NULL
WHERE state = 'proposed';

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

-- PREP: recovery_orphan_prompt_sources
-- {§prompt-loop-containment}: finish an absent or partially staged orphan
-- recovery before queued drains become visible at boot. A non-queued recovery
-- already crossed its delivery boundary and must never be replayed.
SELECT source.id AS loop_id, source.worker_id AS worker_id
FROM loops source
LEFT JOIN loops recovery ON recovery.orphan_source_loop_id = source.id
WHERE source.status IN (200, 413, 429, 499, 500, 504, 508)
  AND (recovery.id IS NULL OR recovery.status = 100)
  AND EXISTS (
      SELECT 1
      FROM entries e
      JOIN entry_channels c ON c.entry_id = e.id AND c.name = 'body'
      WHERE e.scheme = 'prompt'
        AND e.owner_id = source.worker_id
        AND e.pathname LIKE '/' || source.sequence || '/%'
        AND NOT EXISTS (
            SELECT 1 FROM log_entries le
            WHERE le.loop_id = source.id AND le.origin = 'plurnk' AND le.op = 'prompt'
              AND le.scheme = 'prompt' AND le.pathname = e.pathname
        )
  )
ORDER BY source.worker_id, source.sequence;

-- PREP: recovery_queued_workers
SELECT DISTINCT w.id AS worker_id, w.workspace_id
FROM workers w
JOIN loops l ON l.worker_id = w.id
WHERE l.status = 100
  AND NOT EXISTS (
      SELECT 1
      FROM branch_batch_items bi
      JOIN branch_batches bb ON bb.id = bi.batch_id
      WHERE bi.loop_id = l.id
        AND bb.state IN ('collecting', 'queued', 'running', 'recovery_required')
  )
ORDER BY w.id;

-- PREP: recovery_parked_workers
SELECT DISTINCT w.id AS worker_id, w.workspace_id
FROM workers w
JOIN loops l ON l.worker_id = w.id
WHERE l.status = 202
ORDER BY w.id;
