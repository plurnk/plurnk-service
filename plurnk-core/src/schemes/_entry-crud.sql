-- Entry CRUD primitives (SPEC {§crud}). Used by entry-bearing schemes and
-- the engine for cross-scheme COPY/MOVE/SEND signal 410.

-- PREP: crud_find_workspace_entry
-- {§entry-identity-no-null} — every identity component is NOT NULL (bare/absolute paths
-- persist under the reserved 'file' scheme), so plain `=` is the honest comparison.
SELECT id, attributes FROM entries
WHERE workspace_id = $workspace_id AND owner_id = $owner_id AND scheme = $scheme AND pathname = $pathname;

-- PREP: crud_read_channels
SELECT name, content, mimetype, state, producer_result FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: crud_insert_workspace_entry
INSERT INTO entries (workspace_id, owner_id, scheme, pathname)
VALUES ($workspace_id, $owner_id, $scheme, $pathname)
RETURNING id;

-- PREP: crud_insert_workspace_entry_with_attributes
-- Core-private metadata is present at identity creation, before any channel
-- makes the entry visible to a reader.
INSERT INTO entries (workspace_id, owner_id, scheme, pathname, attributes)
VALUES ($workspace_id, $owner_id, $scheme, $pathname, $attributes)
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
INSERT INTO entries (workspace_id, owner_id, scheme, pathname, membership_origin)
VALUES ($workspace_id, $owner_id, $scheme, $pathname, $membership_origin)
ON CONFLICT (workspace_id, owner_id, scheme, pathname)
DO UPDATE SET membership_origin = excluded.membership_origin
RETURNING id;

-- PREP: crud_get_member_sig
-- SPEC {§membership-change-gated-sync} — the member's last-synced disk signature
-- (mtime:size), read before materializing so an unchanged file short-circuits
-- before any content read. File members store scheme='file' ({§entry-identity-no-null}).
SELECT id, synced_sig, membership_origin, attributes FROM entries
WHERE workspace_id = $workspace_id AND owner_id = $owner_id AND scheme = $scheme AND pathname = $pathname;

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
        AND e.pathname = $pathname
  );

-- PREP: crud_delete_entry
DELETE FROM entries WHERE id = $entry_id;

-- PREP: crud_list_reconcilable_members
-- Every file member is overlay-owned (membership_origin IN git, constraint).
-- The reconciliation set: resolveGitMembership compares this against the desired
-- ((git ls-files ∪ add) − ignore) and un-registers the difference, so entries ==
-- members.
SELECT id, pathname FROM entries
WHERE workspace_id = $workspace_id AND scheme = 'file' AND membership_origin IN ('git', 'constraint');

-- PREP: crud_insert_workspace_constraint
-- SPEC {§membership} explicit constraint overlay. Reasserting an exact generated
-- pick promotes it to durable explicit policy; explicit provenance never demotes.
INSERT INTO workspace_constraints (workspace_id, effect, glob, source)
VALUES ($workspace_id, $effect, $glob, 'explicit')
ON CONFLICT (workspace_id, effect, glob)
DO UPDATE SET source = 'explicit';

-- PREP: crud_insert_generated_workspace_constraint
-- {§fs-create-generated-pick}: automatic incorporation uses the same ordinary
-- constraint row. An existing explicit row wins without mutation.
INSERT INTO workspace_constraints (workspace_id, effect, glob, source)
VALUES ($workspace_id, 'pick', $glob, 'create')
ON CONFLICT (workspace_id, effect, glob)
DO NOTHING;

-- PREP: crud_list_workspace_constraints
SELECT effect, glob, source FROM workspace_constraints
WHERE workspace_id = $workspace_id
ORDER BY effect, glob;

-- PREP: crud_delete_workspace_constraint
-- "remove" a constraint — deleting the row, not a fourth effect.
DELETE FROM workspace_constraints WHERE workspace_id = $workspace_id AND effect = $effect AND glob = $glob;

-- PREP: crud_delete_generated_workspace_constraint
-- Automatic lifecycle may remove only its own exact pick, never explicit policy.
DELETE FROM workspace_constraints
WHERE workspace_id = $workspace_id AND effect = 'pick' AND glob = $glob AND source = 'create';

-- PREP: crud_stamp_origin
-- {§fs-write-surface} — the accept stamps the grantor the blind-write closure proved;
-- set-if-null so a reconcile-stamped row is never overwritten.
UPDATE entries SET membership_origin = $membership_origin WHERE id = $entry_id AND membership_origin IS NULL;

-- PREP: crud_set_origin
-- Accept-time incorporation may fall back from Git staging to an exact pick.
UPDATE entries SET membership_origin = $membership_origin WHERE id = $entry_id;
