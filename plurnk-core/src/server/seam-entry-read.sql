-- CoreSeam readEntry queries. SPEC {§methods-entry-read}.

-- PREP: entry_read_lookup
SELECT id, workspace_id, owner_id, scheme, pathname
FROM entries
WHERE workspace_id = $workspace_id
  AND owner_id = $owner_id
  AND scheme = $scheme
  AND pathname = $pathname;

-- PREP: entry_read_channels
SELECT name, content, 0 AS contentOffset, length(content) AS contentLength, mimetype, tokens, state
FROM entry_channels
WHERE entry_id = $entry_id;

-- {§entry-read-result}: return the selected channel suffix in Unicode code points
-- plus its complete current length. SQLite substr is 1-indexed, hence offset + 1.
-- PREP: entry_read_channel_slice
SELECT name,
       substr(content, $offset + 1) AS content,
       min($offset, length(content)) AS contentOffset,
       length(content) AS contentLength,
       mimetype,
       tokens,
       state
FROM entry_channels
WHERE entry_id = $entry_id AND name = $channel;
