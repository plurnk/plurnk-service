-- Entry CRUD primitives (SPEC {§crud}). Used by entry-bearing schemes and
-- the engine for cross-scheme COPY/MOVE/SEND signal 410.

-- PREP: crud_find_workspace_entry
-- {§entry-identity-no-null} — every identity component is NOT NULL (bare/absolute paths
-- persist under the reserved 'file' scheme), so plain `=` is the honest comparison.
SELECT e.id, e.attributes
FROM entries e
JOIN workers owner ON owner.id = e.owner_id
WHERE owner.workspace_id = $workspace_id AND e.owner_id = $owner_id
  AND e.scheme = $scheme AND e.authority = $authority AND e.pathname = $pathname;

-- PREP: crud_read_channels
SELECT name, content, mimetype, state, producer_result FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: crud_insert_workspace_entry
INSERT INTO entries (owner_id, scheme, authority, pathname)
SELECT $owner_id, $scheme, $authority, $pathname
FROM workers WHERE id = $owner_id AND workspace_id = $workspace_id
RETURNING id;

-- PREP: crud_insert_workspace_entry_with_attributes
-- Core-private metadata is present at identity creation, before any channel
-- makes the entry visible to a reader.
INSERT INTO entries (owner_id, scheme, authority, pathname, attributes)
SELECT $owner_id, $scheme, $authority, $pathname, $attributes
FROM workers WHERE id = $owner_id AND workspace_id = $workspace_id
RETURNING id;

-- PREP: crud_set_entry_attributes
-- Core-private entry metadata. Omission at the EntryCrud seam preserves the
-- existing value; an explicit bag replaces it before channels become visible.
UPDATE entries SET attributes = $attributes WHERE id = $entry_id;

-- PREP: crud_register_workspace_member
-- Idempotent bare-membership insert (SPEC {§membership} D4 — git ls-files membership).
-- A git-tracked file is a workspace member by virtue of being tracked; the row
-- is the membership marker the File read-gate checks and FIND globs by path.
-- Channel-less by design — disk stays the truth (D3). Re-resolution updates
-- only provenance so an explicit pick can supersede Git (including outside-root
-- write authority) and removing that pick can return ownership to Git.
INSERT INTO entries (owner_id, scheme, authority, pathname, membership_origin)
SELECT $owner_id, $scheme, $authority, $pathname, $membership_origin
FROM workers WHERE id = $owner_id AND workspace_id = $workspace_id
ON CONFLICT (owner_id, scheme, authority, pathname)
DO UPDATE SET membership_origin = excluded.membership_origin
RETURNING id;

-- PREP: crud_get_member_sig
-- SPEC {§membership-change-gated-sync} — the member's last-synced disk signature
-- (mtime:size), read before materializing so an unchanged file short-circuits
-- before any content read. File members store scheme='file' ({§entry-identity-no-null}).
SELECT e.id, e.synced_sig, e.membership_origin, e.attributes
FROM entries e
JOIN workers owner ON owner.id = e.owner_id
WHERE owner.workspace_id = $workspace_id AND e.owner_id = $owner_id
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

-- PREP: crud_write_channel
-- {§tokenomics-content-hash-identity}: every static write stamps stable content identity.
INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, state, producer_result)
VALUES ($entry_id, $name, $content, $mimetype, $weight, $content_hash, $state, $producer_result);

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

-- PREP: crud_list_reconcilable_members
-- Every file member is overlay-owned (membership_origin IN git, constraint).
-- The reconciliation set: resolveGitMembership compares this against the desired
-- ((git ls-files ∪ add) − ignore) and un-registers the difference, so entries ==
-- members.
SELECT e.id, e.pathname
FROM entries e
JOIN workers owner ON owner.id = e.owner_id
WHERE owner.workspace_id = $workspace_id AND e.scheme = 'file' AND e.authority = ''
  AND e.membership_origin IN ('git', 'constraint');

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
