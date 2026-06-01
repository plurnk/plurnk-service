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

-- PREP: ops_list_visibility_for_entry
-- All visibility rows for a (run, entry) — fragment-less SHOW/HIDE iterates this.
SELECT channel, indexed
FROM visibility
WHERE run_id = $run_id AND entry_id = $entry_id;

-- PREP: ops_upsert_visibility
-- SHOW/HIDE: set indexed bit, upserting on (run_id, entry_id, channel).
INSERT INTO visibility (run_id, entry_id, channel, indexed)
VALUES ($run_id, $entry_id, $channel, $indexed)
ON CONFLICT (run_id, entry_id, channel)
DO UPDATE SET indexed = excluded.indexed;

-- PREP: ops_get_visibility_for_channel
-- Read a single (run, entry, channel) visibility row — fragment-targeted SHOW/HIDE.
SELECT indexed
FROM visibility
WHERE run_id = $run_id AND entry_id = $entry_id AND channel = $channel;
