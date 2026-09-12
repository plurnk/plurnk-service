-- Entry CRUD primitives (SPEC {§crud}). Used by entry-bearing schemes and
-- the engine for cross-scheme COPY/MOVE/KILL.

-- PREP: crud_find_workspace_entry
-- {§entry-identity-no-null} — every identity component is NOT NULL (bare/absolute paths
-- persist under the reserved 'file' scheme), so plain `=` is the honest comparison.
SELECT e.id, e.attributes, e.default_channel, e.output
FROM entries e
WHERE e.workspace_id = $workspace_id
  AND e.scheme = $scheme AND e.authority = $authority AND e.pathname = $pathname;

-- PREP: crud_read_channels
SELECT name, content, mimetype, state, producer_result FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: crud_read_entry
-- {§crud} One read snapshot covers metadata and every channel.
SELECT e.id, e.attributes, c.name, c.content, c.mimetype, c.state, c.producer_result
FROM entries e LEFT JOIN entry_channels c ON c.entry_id = e.id
WHERE e.workspace_id = $workspace_id AND e.scheme = $scheme
  AND e.authority = $authority AND e.pathname = $pathname;

-- PREP: crud_publish_entry
INSERT INTO entry_publication (workspace_id, scheme, authority, pathname, attributes, default_channel, output, channels, created)
SELECT $workspace_id, $scheme, $authority, $pathname, $attributes, $default_channel, $output, $channels,
       NOT EXISTS (SELECT 1 FROM entries WHERE workspace_id = $workspace_id
           AND scheme = $scheme AND authority = $authority AND pathname = $pathname)
WHERE $create_only = 0 OR NOT EXISTS (
    SELECT 1 FROM entries WHERE workspace_id = $workspace_id
      AND scheme = $scheme AND authority = $authority AND pathname = $pathname
)
RETURNING (SELECT id FROM entries WHERE workspace_id = entry_publication.workspace_id
    AND scheme = entry_publication.scheme AND authority = entry_publication.authority
    AND pathname = entry_publication.pathname) AS id, created;

-- PREP: crud_register_workspace_member
-- Idempotent bare-membership insert (SPEC {§membership} D4 — git ls-files membership).
-- A git-tracked file is a workspace member by virtue of being tracked; the row
-- is the membership marker the File read-gate checks and FIND globs by path.
-- Channel-less by design — disk stays the truth (D3). Re-resolution updates
-- only provenance so an explicit pick can supersede Git (including outside-root
-- write authority) and removing that pick can return ownership to Git.
INSERT INTO entries (workspace_id, scheme, authority, pathname, membership_origin)
SELECT $workspace_id, $scheme, $authority, $pathname, $membership_origin
FROM workspaces WHERE id = $workspace_id
ON CONFLICT (workspace_id, scheme, authority, pathname)
DO UPDATE SET membership_origin = excluded.membership_origin
RETURNING id;

-- PREP: crud_register_workspace_members
-- {§membership-reconcile-sets}: the desired file members land as one set — $members is a JSON
-- array of {pathname, origin} — with the same idempotent provenance update as the single form.
INSERT INTO entries (workspace_id, scheme, authority, pathname, membership_origin)
SELECT $workspace_id, 'file', '', json_extract(member.value, '$.pathname'), json_extract(member.value, '$.origin')
FROM json_each($members) AS member
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = $workspace_id)
ON CONFLICT (workspace_id, scheme, authority, pathname)
DO UPDATE SET membership_origin = excluded.membership_origin;

-- PREP: crud_unregister_stale_members
-- {§membership-reconcile-sets}: every overlay-owned file member outside the desired set leaves in
-- one statement. The row's body content rides out with it, so a path that also left disk truth
-- (not a candidate at all) reports its prior content as a divergence; a mere exclusion is silent.
DELETE FROM entries
WHERE workspace_id = $workspace_id AND scheme = 'file' AND authority = ''
  AND membership_origin IN ('git', 'constraint')
  AND pathname NOT IN (SELECT value FROM json_each($desired))
RETURNING id, pathname,
          (SELECT content FROM entry_channels c WHERE c.entry_id = entries.id AND c.name = 'body') AS prior;

-- PREP: crud_get_member_sig
-- SPEC {§membership-change-gated-sync} — the member's last-synced disk signature
-- (mtime:size), read before materializing so an unchanged file short-circuits
-- before any content read. File members store scheme='file' ({§entry-identity-no-null}).
SELECT e.id, e.synced_sig, e.membership_origin, e.attributes
FROM entries e
WHERE e.workspace_id = $workspace_id
  AND e.scheme = $scheme AND e.authority = $authority AND e.pathname = $pathname;

-- PREP: crud_set_synced_sig
-- Stamp the disk signature after a member materializes to disk truth; the next
-- pass compares against it to skip an unchanged member.
UPDATE entries SET synced_sig = $synced_sig WHERE id = $entry_id;

-- PREP: crud_mark_member_absent
-- An observed deletion keeps the Git membership marker but removes its stale
-- readable/derived representation. `absent` distinguishes that observed state
-- from a member that has never been synchronized.
UPDATE entries SET synced_sig = 'absent' WHERE id = $entry_id;

-- PREP: crud_delete_channels
DELETE FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: crud_delete_channel
DELETE FROM entry_channels WHERE entry_id = $entry_id AND name = $name
RETURNING name;

-- PREP: crud_attach_channel_derivation
-- Attach only while the channel still denotes the exact representation that
-- was derived. A concurrent stream append or replacement leaves it unattached
-- for the next maintenance pass instead of publishing stale search evidence.
UPDATE entry_channels
SET deep_hash = $deep_hash
WHERE entry_id = $entry_id
  AND name = $channel
  AND content = $content
  AND mimetype = $mimetype
  AND EXISTS (
      SELECT 1
      FROM entries e
      WHERE e.id = entry_channels.entry_id
        AND e.scheme = $scheme
        AND e.authority = $authority
        AND e.pathname = $pathname
  );

-- PREP: crud_delete_entry
DELETE FROM entries WHERE id = $entry_id;

-- PREP: crud_insert_generated_workspace_constraint
-- {§fs-create-record}: an accepted creation is incorporated by an exact record row; a projected
-- definition already holding the same path leaves it alone.
INSERT INTO workspace_constraints (workspace_id, effect, glob, source)
VALUES ($workspace_id, 'include', $glob, 'create')
ON CONFLICT (workspace_id, effect, glob)
DO NOTHING;

-- PREP: crud_list_workspace_constraints
SELECT effect, glob, source FROM workspace_constraints
WHERE workspace_id = $workspace_id
ORDER BY effect, glob;

-- PREP: crud_delete_generated_workspace_constraint
-- Automatic lifecycle may remove only its own exact creation record, never a projected definition.
DELETE FROM workspace_constraints
WHERE workspace_id = $workspace_id AND effect = 'include' AND glob = $glob AND source = 'create';

-- PREP: crud_delete_family_workspace_constraints
-- {§members-projection}: the members family owns its projected rows and replaces them whole.
DELETE FROM workspace_constraints
WHERE workspace_id = $workspace_id AND source IN ('members', 'model');

-- PREP: crud_insert_family_workspace_constraint
-- A projected row never overwrites a creation record ({§fs-create-masked}); the family deleted its
-- own rows first, so that record is the only conflict left.
INSERT INTO workspace_constraints (workspace_id, effect, glob, source)
VALUES ($workspace_id, $effect, $glob, $source)
ON CONFLICT (workspace_id, effect, glob)
DO NOTHING;

-- PREP: crud_stamp_origin
-- {§fs-write-surface} — the accept stamps the grantor the blind-write closure proved;
-- set-if-null so a reconcile-stamped row is never overwritten.
UPDATE entries SET membership_origin = $membership_origin WHERE id = $entry_id AND membership_origin IS NULL;

-- PREP: crud_set_origin
-- Accept-time incorporation may fall back from Git staging to an exact pick.
UPDATE entries SET membership_origin = $membership_origin WHERE id = $entry_id;

-- PREP: crud_upsert_readable_channel
-- {§readable-channel} — the derived `readable` sibling of a source channel lands or refreshes
-- with the source; it is never written by an operation.
INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, state, producer_result)
VALUES ($entry_id, 'readable', $content, $mimetype, $weight, $content_hash, 'static', NULL)
ON CONFLICT (entry_id, name) DO UPDATE SET
    content = excluded.content,
    mimetype = excluded.mimetype,
    weight = excluded.weight,
    content_hash = excluded.content_hash,
    state = 'static',
    producer_result = NULL
WHERE entry_channels.content_hash IS NOT excluded.content_hash;

-- PREP: crud_delete_readable_channel
DELETE FROM entry_channels WHERE entry_id = $entry_id AND name = 'readable';

-- INIT: entry_channels_invalidate_derivation
-- A changed channel representation cannot retain search evidence derived from
-- its predecessor. This trigger is the one invalidation owner for every write
-- path, including model EDIT, plugin channel capabilities, and streams.
DROP TRIGGER IF EXISTS entry_channels_invalidate_derivation;
CREATE TRIGGER entry_channels_invalidate_derivation
AFTER UPDATE OF content, mimetype ON entry_channels
WHEN OLD.content IS NOT NEW.content OR OLD.mimetype IS NOT NEW.mimetype
BEGIN
    UPDATE entry_channels
    SET deep_hash = NULL
    WHERE entry_id = NEW.entry_id AND name = NEW.name AND deep_hash IS NOT NULL;
END;

-- INIT: entries_touch_on_channel_write
-- User Note 5 — bump the entry's updated_at on addressable representation or
-- lifecycle writes so the catalog (ordered by updated_at ASC) keeps recently-
-- touched entries at the tail and holds the prompt-cache prefix stable across
-- turns. Content hashes and search attachments are private metadata, not touches.
DROP TRIGGER IF EXISTS entries_touch_on_channel_write;
CREATE TRIGGER entries_touch_on_channel_write
AFTER INSERT ON entry_channels
BEGIN
    UPDATE entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.entry_id;
END;

-- INIT: entries_touch_on_channel_update
DROP TRIGGER IF EXISTS entries_touch_on_channel_update;
CREATE TRIGGER entries_touch_on_channel_update
AFTER UPDATE OF content, mimetype, weight, state, producer_result ON entry_channels
BEGIN
    UPDATE entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.entry_id;
END;
