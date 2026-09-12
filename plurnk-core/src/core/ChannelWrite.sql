-- Channel-write SQL for streaming schemes. SPEC {§channel-state} + {§subscriptions} + {§notifications}.

-- PREP: channel_meta
SELECT e.workspace_id, e.scheme, e.authority, e.pathname, ec.state, ec.mimetype, length(ec.content) AS contentLength
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
INSERT INTO subscriptions (worker_id, entry_id, scheme, handle, poll_seconds, turn_scoped, published_channel, source)
VALUES ($worker_id, $entry_id, $scheme, $handle, $poll_seconds, COALESCE($turn_scoped, 0), $published_channel, $source)
RETURNING id;

-- PREP: close_subscription
UPDATE subscriptions
SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  , close_status = $status
  , close_result = $result
  , channel_results = $channel_results
WHERE id = $subscription_id AND closed_at IS NULL;

-- PREP: subscription_published_channel_meta
SELECT e.id AS entryId, s.worker_id AS workerId, e.workspace_id, e.scheme, e.authority, e.pathname,
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
WHERE entry_id = $entry_id AND closed_at IS NULL;

-- PREP: find_open_subscriptions_for_worker
-- The worker's still-open subscriptions — the registry-routed reap ({§worker-lifecycle-total-reap}):
-- loop.cancel / KILL / shutdown iterate these and abort each via the owning scheme, so a
-- backgrounded exec is reaped independent of any in-process AbortSignal-listener timing.
SELECT id, scheme
FROM subscriptions
WHERE worker_id = $worker_id AND closed_at IS NULL;

-- PREP: find_open_turn_scoped_subscriptions_for_worker
-- The worker's open turn-scoped (EXEC `<0>`) subscriptions — reaped at the worker's next pre-turn so a
-- `<0>` stream never survives into the subsequent turn; its terminal output surfaces initially visible
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
  AND e.scheme = $scheme AND e.authority = $authority AND e.pathname = $pathname
  AND s.closed_at IS NOT NULL
ORDER BY s.closed_at DESC
LIMIT 1;

-- INIT: subscriptions_wake_revision
DROP TRIGGER IF EXISTS subscriptions_wake_revision;
CREATE TRIGGER subscriptions_wake_revision
AFTER UPDATE OF closed_at ON subscriptions
WHEN OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
BEGIN
    UPDATE workers SET wake_revision = wake_revision + 1 WHERE id = NEW.worker_id;
END;

-- INIT: subscriptions_settle_channels
-- Subscription settlement is the single atomic transition that closes the
-- lifecycle and installs current terminal producer evidence on every channel.
-- Overrides are exact; all other channels inherit the universal result.
DROP TRIGGER IF EXISTS subscriptions_settle_channels;
CREATE TRIGGER subscriptions_settle_channels
AFTER UPDATE OF closed_at, close_status, close_result, channel_results ON subscriptions
WHEN OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
BEGIN
    UPDATE entry_channels
    SET producer_result = COALESCE(
            (
                SELECT json(channel_result.value)
                FROM json_each(NEW.channel_results) AS channel_result
                WHERE channel_result.key = entry_channels.name
            ),
            NEW.close_result
        ),
        state = CASE WHEN json_extract(
            COALESCE(
                (
                    SELECT json(channel_result.value)
                    FROM json_each(NEW.channel_results) AS channel_result
                    WHERE channel_result.key = entry_channels.name
                ),
                NEW.close_result
            ),
            '$.status'
        ) >= 400 THEN 'errored' ELSE 'closed' END
    WHERE entry_id = NEW.entry_id;
END;

-- INIT: subscriptions_seed_publications
DROP TRIGGER IF EXISTS subscriptions_seed_publications;
CREATE TRIGGER subscriptions_seed_publications
AFTER INSERT ON subscriptions
BEGIN
    INSERT INTO subscription_publications (subscription_id, channel)
    SELECT NEW.id, ec.name
    FROM entry_channels ec
    WHERE ec.entry_id = NEW.entry_id
      AND (NEW.published_channel IS NULL OR ec.name = NEW.published_channel);

    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM subscription_publications WHERE subscription_id = NEW.id
    ) THEN RAISE(ABORT, 'subscription has no publishable channel') END;
END;

-- INIT: log_entries_advance_subscription_publication
-- The generated READ and its cursor transition are one SQLite statement. A
-- later log KILL removes evidence from active context without rewinding the
-- subscription/channel publication state. {§exec-stream}
DROP TRIGGER IF EXISTS log_entries_advance_subscription_publication;
CREATE TRIGGER log_entries_advance_subscription_publication
AFTER INSERT ON log_entries
WHEN NEW.subscription_publication_id IS NOT NULL
BEGIN
    SELECT CASE WHEN
        NEW.origin != '_plurnk'
        OR NEW.op != 'READ'
        OR json_type(NEW.attrs, '$.streamEnd') != 'integer'
        OR json_extract(NEW.attrs, '$.streamEnd') < 0
        OR json_type(NEW.attrs, '$.terminal') NOT IN ('true', 'false')
    THEN RAISE(ABORT, 'subscription publication requires one canonical stream observation') END;

    UPDATE subscription_publications
    SET published_end = json_extract(NEW.attrs, '$.streamEnd'),
        terminal_published = json_extract(NEW.attrs, '$.terminal'),
        version = version + 1
    WHERE id = NEW.subscription_publication_id
      AND terminal_published = 0
      AND (
          (json_extract(NEW.attrs, '$.terminal') = 0
              AND json_extract(NEW.attrs, '$.streamEnd') > published_end)
          OR
          (json_extract(NEW.attrs, '$.terminal') = 1
              AND json_extract(NEW.attrs, '$.streamEnd') >= published_end)
      );

    SELECT CASE WHEN changes() != 1
        THEN RAISE(ABORT, 'subscription publication transition is stale or already terminal')
    END;
END;
