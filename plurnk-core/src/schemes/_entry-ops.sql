-- Workspace-entry op handlers for entry-bearing schemes (SPEC {§scheme}, {§channel-selection}).
-- Some queries reuse PREPs declared in _entry-crud.sql:
--   crud_find_workspace_entry, crud_write_tag

-- PREP: ops_insert_workspace_entry_if_absent
-- EDIT creation claims identity without surfacing a uniqueness exception when
-- another correct writer wins the same resource concurrently.
INSERT INTO entries (owner_id, scheme, authority, pathname)
SELECT $owner_id, $scheme, $authority, $pathname
FROM workers WHERE id = $owner_id AND workspace_id = $workspace_id
ON CONFLICT (owner_id, scheme, authority, pathname) DO NOTHING
RETURNING id;

-- PREP: ops_insert_channel_if_absent
-- The creation half of EDIT's atomic landing. A concurrent creator wins cleanly;
-- the caller translates an empty RETURNING set to the shared edit-collision.
INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, state, producer_result)
VALUES ($entry_id, $name, $content, $mimetype, $weight, $content_hash, 'static', NULL)
ON CONFLICT (entry_id, name) DO NOTHING
RETURNING name;

-- PREP: ops_update_channel_if_content
-- The replacement half of EDIT's atomic landing. The exact representation used
-- to calculate line edits remains the compare-and-swap precondition at mutation.
UPDATE entry_channels
SET content = $content,
    mimetype = $mimetype,
    weight = $weight,
    content_hash = $content_hash,
    state = 'static',
    producer_result = NULL
WHERE entry_id = $entry_id
  AND name = $name
  AND content = $expected_content
RETURNING name;

-- PREP: ops_read_channel
-- READ targeting a specific channel of an entry — identity is
-- (owner, scheme, authority, pathname); owner determines workspace.
SELECT ec.content, ec.mimetype, ec.producer_result
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
JOIN workers owner ON owner.id = e.owner_id
WHERE owner.workspace_id = $workspace_id AND e.owner_id = $owner_id
  AND e.scheme = $scheme
  AND e.authority = $authority
  AND e.pathname = $pathname
  AND ec.name = $channel;
