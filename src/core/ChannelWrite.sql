-- Channel-write SQL for streaming schemes. SPEC §5.6 + §7.1 + §13.6.

-- PREP: channel_meta
SELECT e.session_id, e.scheme, e.pathname, ec.state, length(ec.content) AS contentLength
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

-- PREP: replace_channel_content
-- Full content swap for one channel (ChannelCaps.replace). Re-tokenizes at
-- write (unlike append_to_channel, which defers token count to render).
UPDATE entry_channels
SET content = $content, tokens = $tokens
WHERE entry_id = $entry_id AND name = $channel;

-- PREP: open_subscription
INSERT INTO subscriptions (run_id, entry_id, scheme, handle)
VALUES ($run_id, $entry_id, $scheme, $handle)
RETURNING id;

-- PREP: close_subscription
UPDATE subscriptions
SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  , close_status = $status
WHERE id = $subscription_id AND closed_at IS NULL;

-- PREP: find_active_subscription
SELECT id, scheme, handle
FROM subscriptions
WHERE run_id = $run_id AND entry_id = $entry_id AND closed_at IS NULL;
