-- Session-entry op handlers for entry-bearing schemes (SPEC §3, §5.5).
-- Some queries reuse PREPs declared in _entry-crud.sql:
--   crud_find_session_entry, crud_write_visibility, crud_write_tag

-- PREP: ops_upsert_channel
-- EDIT semantics: replace channel content if it exists.
INSERT OR REPLACE INTO entry_channels (entry_id, name, content, mimetype, tokens, state)
VALUES ($entry_id, $name, $content, $mimetype, $tokens, 'static');

-- PREP: ops_read_channel
-- READ targeting a specific channel of a session entry.
SELECT ec.content, ec.mimetype
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.scope = 'session'
  AND e.session_id = $session_id
  AND e.scheme = $scheme
  AND e.pathname = $pathname
  AND ec.name = $channel;

-- PREP: ops_upsert_visibility
-- SHOW/HIDE: set indexed bit, upserting on (run_id, entry_id, channel).
INSERT INTO visibility (run_id, entry_id, channel, indexed)
VALUES ($run_id, $entry_id, $channel, $indexed)
ON CONFLICT (run_id, entry_id, channel)
DO UPDATE SET indexed = excluded.indexed;

-- PREP: bulk_upsert_visibility
-- SHOW/HIDE over a set: set $indexed for every channel in $channels (JSON array)
-- of every session entry whose pathname is in $pathnames (JSON array). Entries
-- resolve in SQL — no per-pathname lookup. ON CONFLICT skips rows already at the
-- target (WHERE indexed != excluded), so changes() is the real changed-count
-- (callers map 0 -> 304).
INSERT INTO visibility (run_id, entry_id, channel, indexed)
SELECT $run_id, e.id, c.value, $indexed
FROM entries e
CROSS JOIN json_each($channels) c
WHERE e.scope = 'session' AND e.session_id = $session_id AND e.scheme = $scheme
  AND e.pathname IN (SELECT value FROM json_each($pathnames))
ON CONFLICT (run_id, entry_id, channel)
DO UPDATE SET indexed = excluded.indexed
WHERE visibility.indexed != excluded.indexed;

-- PREP: ops_get_visibility_for_channel
-- Read a single (run, entry, channel) visibility row — visibility-state inspection.
SELECT indexed
FROM visibility
WHERE run_id = $run_id AND entry_id = $entry_id AND channel = $channel;
