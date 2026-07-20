-- Workspace-entry op handlers for entry-bearing schemes (SPEC §scheme, §channel-selection).
-- Some queries reuse PREPs declared in _entry-crud.sql:
--   crud_find_workspace_entry, crud_write_tag

-- PREP: ops_upsert_channel
-- EDIT semantics: replace channel content if it exists.
INSERT OR REPLACE INTO entry_channels (entry_id, name, content, mimetype, tokens, state)
VALUES ($entry_id, $name, $content, $mimetype, $tokens, 'static');

-- PREP: ops_read_channel
-- READ targeting a specific channel of an entry — identity is (workspace, owner, scheme, pathname).
SELECT ec.content, ec.mimetype
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.workspace_id = $workspace_id
  AND e.owner_id = $owner_id
  AND e.scheme = $scheme
  AND e.pathname = $pathname
  AND ec.name = $channel;

