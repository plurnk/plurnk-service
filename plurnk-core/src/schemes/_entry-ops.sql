-- Workspace-entry op handlers for entry-bearing schemes (SPEC §scheme, §channel-selection).
-- Some queries reuse PREPs declared in _entry-crud.sql:
--   crud_find_workspace_entry, crud_write_tag

-- PREP: ops_upsert_channel
-- EDIT semantics: replace channel content if it exists.
INSERT OR REPLACE INTO entry_channels (entry_id, name, content, mimetype, tokens, state)
VALUES ($entry_id, $name, $content, $mimetype, $tokens, 'static');

-- PREP: ops_read_channel
-- READ targeting a specific channel of a workspace entry.
SELECT ec.content, ec.mimetype
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.scope = 'workspace'
  AND e.workspace_id = $workspace_id
  AND e.scheme IS $scheme
  AND e.pathname = $pathname
  AND ec.name = $channel;

-- PREP: ops_read_channel_worker
-- Run-scope twin of ops_read_channel (§worker-scheme).
SELECT ec.content, ec.mimetype
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.scope = 'worker'
  AND e.workspace_id = $workspace_id
  AND e.scheme IS $scheme
  AND e.pathname = $pathname
  AND ec.name = $channel;

