-- entry.read RPC queries. SPEC §13.5.

-- PREP: entry_read_lookup
SELECT id, scope, session_id, scheme, pathname
FROM entries
WHERE session_id = $session_id AND scheme = $scheme AND pathname = $pathname;

-- PREP: entry_read_channels
SELECT name, content, mimetype, tokens, state
FROM entry_channels
WHERE entry_id = $entry_id;
