-- ApplicationPort readEntry queries. SPEC {§methods-entry-read}.

-- PREP: entry_read_lookup
SELECT e.id, owner.workspace_id, e.owner_id, e.scheme, e.authority, e.pathname
FROM entries e
JOIN workers owner ON owner.id = e.owner_id
WHERE owner.workspace_id = $workspace_id
  AND e.owner_id = $owner_id
  AND e.scheme = $scheme
  AND e.authority = $authority
  AND e.pathname = $pathname;

-- PREP: entry_read_channels
SELECT name, content, 0 AS contentOffset, length(content) AS contentLength, mimetype, weight, state
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
       weight,
       state
FROM entry_channels
WHERE entry_id = $entry_id AND name = $channel;
