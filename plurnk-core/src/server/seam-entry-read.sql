-- entry.read RPC queries. SPEC §methods.

-- PREP: entry_read_lookup
SELECT id, workspace_id, owner_id, scheme, pathname
FROM entries
WHERE workspace_id = $workspace_id AND scheme = $scheme AND pathname = $pathname
LIMIT 1;

-- PREP: entry_read_channels
SELECT name, content, length(content) AS contentLength, mimetype, tokens, state
FROM entry_channels
WHERE entry_id = $entry_id;

-- entry.read({channel, offset}) — incremental delta read for streaming viewers
-- (#192): substr ships only content from $offset (chars — the unit contentLength
-- counts), and contentLength is the full length so the client's next offset
-- survives growth between a stream/event and this read. $offset=0 → whole channel;
-- $offset past the end → '' (caught up). SQLite substr is 1-indexed → $offset + 1.
-- PREP: entry_read_channel_slice
SELECT name, substr(content, $offset + 1) AS content, length(content) AS contentLength, mimetype, tokens, state
FROM entry_channels
WHERE entry_id = $entry_id AND name = $channel;
