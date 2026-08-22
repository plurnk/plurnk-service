-- Channel-write SQL for streaming schemes. SPEC {§channel-state} + {§subscriptions} + {§notifications}.

-- PREP: channel_meta
SELECT e.workspace_id, e.owner_id AS workerId, e.scheme, e.authority, e.pathname, ec.state, ec.mimetype, length(ec.content) AS contentLength
FROM entry_channels ec
JOIN entries e ON e.id = ec.entry_id
WHERE ec.entry_id = $entry_id AND ec.name = $channel;

-- PREP: append_to_channel
UPDATE entry_channels
SET content = content || $chunk,
    weight = content_weight(content || $chunk),
    content_hash = NULL,
    producer_result = NULL
WHERE entry_id = $entry_id AND name = $channel;

-- PREP: set_channel_state
UPDATE entry_channels
SET state = $state
WHERE entry_id = $entry_id AND name = $channel;

-- PREP: set_channel_mimetype
-- A dynamic scheme may supply the body's per-call type. Conditional so
-- labelling every chunk is a steady-state no-op. {§channel-mimetype}
UPDATE entry_channels
SET mimetype = $mimetype
WHERE entry_id = $entry_id AND name = $channel AND mimetype != $mimetype;

-- PREP: replace_channel_content
-- Full content swap for one channel (ChannelCaps.replace). The caller binds
-- the same curation weight append_to_channel computes inside its atomic update.
UPDATE entry_channels
SET content = $content, weight = $weight, content_hash = NULL, producer_result = NULL
WHERE entry_id = $entry_id AND name = $channel;

-- PREP: open_subscription
-- turn_scoped COALESCEs to 0 so a caller binding the raw prep without it (an unbounded stream) is
-- a normal, non-turn-scoped subscription — the column is NOT NULL, so a missing bind would error.
INSERT INTO subscriptions (worker_id, entry_id, scheme, handle, poll_seconds, turn_scoped, published_channel)
VALUES ($worker_id, $entry_id, $scheme, $handle, $poll_seconds, COALESCE($turn_scoped, 0), $published_channel)
RETURNING id;

-- PREP: close_subscription
UPDATE subscriptions
SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  , close_status = $status
  , close_result = $result
  , channel_results = $channel_results
WHERE id = $subscription_id AND closed_at IS NULL;

-- PREP: subscription_published_channel_meta
SELECT e.id AS entryId, e.workspace_id, e.owner_id AS workerId, e.scheme, e.authority, e.pathname,
       ec.name AS channel, ec.state, ec.mimetype,
       length(ec.content) AS contentLength
FROM subscriptions s
JOIN subscription_publications sp ON sp.subscription_id = s.id
JOIN entries e ON e.id = s.entry_id
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = sp.channel
WHERE s.id = $subscription_id;

-- PREP: find_active_subscription
SELECT id, scheme, handle
FROM subscriptions
WHERE worker_id = $worker_id AND entry_id = $entry_id AND closed_at IS NULL;

-- PREP: find_open_subscriptions_for_worker
-- The worker's still-open subscriptions — the registry-routed reap ({§worker-lifecycle-total-reap}):
-- loop.cancel / KILL / shutdown iterate these and abort each via the owning scheme, so a
-- backgrounded exec is reaped independent of any in-process AbortSignal-listener timing.
SELECT id, scheme
FROM subscriptions
WHERE worker_id = $worker_id AND closed_at IS NULL;

-- PREP: find_open_turn_scoped_subscriptions_for_worker
-- The worker's open turn-scoped (EXEC `<0>`) subscriptions — reaped at the worker's next pre-turn so a
-- `<0>` stream never survives into the subsequent turn; its terminal output surfaces born-OPEN
-- through the same conclusion-delta path as any close ({§exec-poll}, {§exec-stream}).
SELECT id, scheme
FROM subscriptions
WHERE worker_id = $worker_id AND closed_at IS NULL AND turn_scoped = 1;

-- PREP: find_exec_close_status
-- Terminal outcome of a finished exec stream, addressed by its coordinate
-- pathname — the KILL-on-a-non-running-exec lookup. 499 (aborted) = killed
-- earlier; any other terminal status = exited naturally; no row = unknown exec.
SELECT s.close_status
FROM entries e
JOIN subscriptions s ON s.entry_id = e.id
WHERE e.workspace_id = $workspace_id
  AND s.worker_id = $worker_id
  AND e.scheme = $scheme AND e.authority = $authority AND e.pathname = $pathname
  AND s.closed_at IS NOT NULL
ORDER BY s.closed_at DESC
LIMIT 1;
