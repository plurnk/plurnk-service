-- Channel-write SQL for streaming schemes. SPEC §channel-state + §subscriptions + §notifications.

-- PREP: channel_meta
SELECT e.workspace_id, e.scheme, e.pathname, ec.state, ec.mimetype, length(ec.content) AS contentLength
FROM entry_channels ec
JOIN entries e ON e.id = ec.entry_id
WHERE ec.entry_id = $entry_id AND ec.name = $channel;

-- PREP: append_to_channel
UPDATE entry_channels
SET content = content || $chunk
WHERE entry_id = $entry_id AND name = $channel;

-- PREP: set_channel_state
UPDATE entry_channels
SET state = $state
WHERE entry_id = $entry_id AND name = $channel;

-- PREP: set_channel_mimetype
-- A streaming scheme labels the channel with the body's per-call type (#226 —
-- http's Content-Type varies per fetch). Conditional: only writes when the type
-- actually changed, so labelling every chunk is a steady-state no-op.
UPDATE entry_channels
SET mimetype = $mimetype
WHERE entry_id = $entry_id AND name = $channel AND mimetype != $mimetype;

-- PREP: replace_channel_content
-- Full content swap for one channel (ChannelCaps.replace). Re-tokenizes at
-- write (unlike append_to_channel, which defers token count to render).
UPDATE entry_channels
SET content = $content, tokens = $tokens
WHERE entry_id = $entry_id AND name = $channel;

-- PREP: open_subscription
-- turn_scoped COALESCEs to 0 so a caller binding the raw prep without it (an unbounded stream) is
-- a normal, non-turn-scoped subscription — the column is NOT NULL, so a missing bind would error.
INSERT INTO subscriptions (worker_id, entry_id, scheme, handle, poll_seconds, turn_scoped)
VALUES ($worker_id, $entry_id, $scheme, $handle, $poll_seconds, COALESCE($turn_scoped, 0))
RETURNING id;

-- PREP: close_subscription
UPDATE subscriptions
SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  , close_status = $status
WHERE id = $subscription_id AND closed_at IS NULL;

-- PREP: find_active_subscription
SELECT id, scheme, handle
FROM subscriptions
WHERE worker_id = $worker_id AND entry_id = $entry_id AND closed_at IS NULL;

-- PREP: find_open_subscriptions_for_worker
-- The worker's still-open subscriptions — the registry-routed reap (§worker-lifecycle-total-reap):
-- loop.cancel / KILL / shutdown iterate these and abort each via the owning scheme, so a
-- backgrounded exec is reaped independent of any in-process AbortSignal-listener timing.
SELECT id, scheme
FROM subscriptions
WHERE worker_id = $worker_id AND closed_at IS NULL;

-- PREP: find_open_turn_scoped_subscriptions_for_worker
-- The worker's open turn-scoped (EXEC `<0>`) subscriptions — reaped at the worker's next pre-turn so a
-- `<0>` stream never survives into the subsequent turn; its terminal output surfaces born-OPEN
-- through the same conclusion-delta path as any close (§exec-poll, §exec-stream).
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
WHERE e.scope = 'workspace' AND e.workspace_id = $workspace_id
  AND e.scheme = 'exec' AND e.pathname = $pathname
  AND s.closed_at IS NOT NULL
ORDER BY s.closed_at DESC
LIMIT 1;

-- PREP: read_channel_content
-- §semantic-fts-at-write — a settled stream's accumulated body, read once for the
-- write-time FTS index.
SELECT content FROM entry_channels WHERE entry_id = $entry_id AND name = $channel;
