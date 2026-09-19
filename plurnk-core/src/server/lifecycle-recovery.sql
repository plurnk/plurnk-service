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
            'type', 'https://problems.plurnk.xyz/lifecycle/recovery/owner-vanished',
            'title', 'Owner vanished',
            'status', 500,
            'detail', 'The daemon restarted while this loop was active; its process-local owner no longer exists.',
            'instance', 'ops://' || (SELECT name FROM workers WHERE workers.id = loops.worker_id) || '/' || sequence
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
;

-- PREP: recovery_fail_open_model_calls
-- The process-local model-call owner vanished. Physical requests have already
-- been settled above, preserving unknown evidence without fabricating zero use.
INSERT INTO model_call_observation (id, failure)
SELECT mc.id, json_object(
        'status', 500,
        'problem', json_object(
            'type', 'https://problems.plurnk.xyz/lifecycle/recovery/owner-vanished',
            'title', 'Owner vanished',
            'status', 500,
            'detail', 'The daemon restarted before this provider response was durably observed; whether the provider completed the call is unknown.'
        )
    )
FROM model_calls mc
WHERE (SELECT state FROM inference_calls WHERE id = mc.id) = 'pending';

-- PREP: recovery_fail_open_turns
-- Every open turn has lost its process-local producer, including a narrow crash
-- window after its loop parked or queued. Provider evidence settles first; then
-- the producer-neutral lifecycle closes every unfinished container without
-- fabricating packet evidence.
UPDATE turns
SET status = 500,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE completed_at IS NULL;

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
            'type', 'https://problems.plurnk.xyz/lifecycle/recovery/owner-vanished',
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
    -- Recovery failures expose their Problem on the metadata line and have no
    -- canonical log body, so their stored curation weight is exactly zero.
    weight = 0,
    deep_hash = NULL
WHERE state = 'proposed';

-- PREP: recovery_remove_ownerless_client_interactions
-- The durable request can be re-presented only while its exact process-local
-- awaiting owner exists. No response was recorded, so recovery removes the
-- orphan instead of fabricating a cancellation or replaying its operation.
DELETE FROM client_interactions;

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
            'type', 'https://problems.plurnk.xyz/lifecycle/recovery/owner-vanished',
            'title', 'Owner vanished',
            'status', 500,
            'detail', 'The daemon restarted while this stream was active; its process-local owner no longer exists.'
        )
    ),
    channel_results = '{}'
WHERE closed_at IS NULL;

-- PREP: recovery_resume_unblocked_parks
-- {§loop-wake-identity}: a persisted completion beats a future observation. Otherwise
-- only a now-empty join wakes here; observation ownership is restored below
-- through the same scheduler used after a live park.
UPDATE loops
SET status = 100,
    wait_poll_at = NULL
WHERE status = 202
  AND (observed_wake_revision < (SELECT wake_revision FROM workers WHERE id = loops.worker_id)
  OR EXISTS (SELECT 1 FROM awaited_events a WHERE a.loop_id = loops.id AND a.result IS NOT NULL AND a.observed = 0)
  OR EXISTS (SELECT 1 FROM loop_obligations held WHERE held.loop_id = loops.id
      AND held.streams = 0 AND held.workers = 0 AND held.events = 0));

-- PREP: recovery_orphan_message_sources
-- {§message-loop-containment}: finish an absent or partially staged orphan
-- recovery before queued drains become visible at boot. A non-queued recovery
-- already crossed its delivery boundary and must never be replayed.
SELECT source.id AS loop_id, source.worker_id AS worker_id, w.origin
FROM loops source
JOIN workers w ON w.id = source.worker_id
LEFT JOIN loops recovery ON recovery.orphan_source_loop_id = source.id
WHERE source.status IN (200, 413, 429, 499, 500, 504, 508)
  AND source.terminated_by IS NOT 'cancel'
  AND source.sequence > w.cancelled_through_sequence
  AND (recovery.id IS NULL OR recovery.status = 100)
  AND EXISTS (SELECT 1 FROM loop_messages m WHERE m.loop_id = source.id AND m.ordinal > 1 AND m.log_entry_id IS NULL)
ORDER BY source.worker_id, source.sequence;
-- PREP: recovery_queued_workers
SELECT DISTINCT w.id AS worker_id, w.workspace_id, w.origin
FROM workers w
JOIN loops l ON l.worker_id = w.id
WHERE l.status = 100
ORDER BY w.id;

-- PREP: recovery_parked_workers
SELECT DISTINCT w.id AS worker_id, w.workspace_id, w.origin
FROM workers w
JOIN loops l ON l.worker_id = w.id
WHERE l.status = 202
ORDER BY w.id;
