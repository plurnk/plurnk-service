-- Entry CRUD primitives (SPEC {§crud}). Used by entry-bearing schemes and
-- the engine for cross-scheme COPY/MOVE/SEND[410].

-- PREP: crud_find_workspace_entry
-- {§entry-identity-no-null} — every identity component is NOT NULL (bare/absolute paths
-- persist under the reserved 'file' scheme), so plain `=` is the honest comparison.
SELECT id FROM entries
WHERE workspace_id = $workspace_id AND owner_id = $owner_id AND scheme = $scheme AND pathname = $pathname;

-- PREP: crud_read_channels
SELECT name, content, mimetype, state FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: crud_read_tags
SELECT tag FROM entry_tags WHERE entry_id = $entry_id ORDER BY tag;

-- PREP: crud_insert_workspace_entry
INSERT INTO entries (workspace_id, owner_id, scheme, pathname)
VALUES ($workspace_id, $owner_id, $scheme, $pathname)
RETURNING id;

-- PREP: crud_register_workspace_member
-- Idempotent bare-membership insert (SPEC {§membership} D4 — git ls-files membership).
-- A git-tracked file is a workspace member by virtue of being tracked; the row
-- is the membership marker the File read-gate checks and FIND globs by path.
-- Channel-less by design — disk stays the truth (D3). ON CONFLICT no-ops so
-- re-resolving membership each turn never duplicates or churns rows.
INSERT INTO entries (workspace_id, owner_id, scheme, pathname, membership_origin)
VALUES ($workspace_id, $owner_id, $scheme, $pathname, $membership_origin)
ON CONFLICT (workspace_id, owner_id, scheme, pathname)
DO NOTHING
RETURNING id;

-- PREP: crud_get_member_sig
-- SPEC {§membership-change-gated-sync} — the member's last-synced disk signature
-- (mtime:size), read before materializing so an unchanged file short-circuits
-- before any content read. File members store scheme='file' ({§entry-identity-no-null}).
SELECT id, synced_sig, membership_origin FROM entries
WHERE workspace_id = $workspace_id AND owner_id = $owner_id AND scheme = $scheme AND pathname = $pathname;

-- PREP: crud_set_synced_sig
-- Stamp the disk signature after a member materializes to disk truth; the next
-- pass compares against it to skip an unchanged member.
UPDATE entries SET synced_sig = $synced_sig WHERE id = $entry_id;

-- PREP: crud_delete_channels
DELETE FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: crud_delete_channel
DELETE FROM entry_channels WHERE entry_id = $entry_id AND name = $name
RETURNING name;

-- PREP: crud_delete_tags
DELETE FROM entry_tags WHERE entry_id = $entry_id;

-- PREP: crud_write_channel
-- #312 — content_hash stamped at every static write: the join key into token_counts.
INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens, content_hash, state)
VALUES ($entry_id, $name, $content, $mimetype, $tokens, $content_hash, $state);

-- PREP: crud_write_tag
INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES ($entry_id, $tag);

-- PREP: crud_delete_tag
DELETE FROM entry_tags WHERE entry_id = $entry_id AND tag = $tag;

-- PREP: crud_delete_entry
DELETE FROM entries WHERE id = $entry_id;

-- PREP: crud_list_reconcilable_members
-- Overlay-owned file members of a workspace (membership_origin IN git, constraint).
-- The reconciliation set: resolveGitMembership compares this against the desired
-- ((git ls-files ∪ add) − ignore) and un-registers the difference, so entries ==
-- members. Model-created ('client') members are excluded — not git's to reclaim.
SELECT id, pathname FROM entries
WHERE workspace_id = $workspace_id AND scheme = 'file' AND membership_origin IN ('git', 'constraint');

-- PREP: crud_insert_workspace_constraint
-- SPEC {§membership} constraint overlay — the client supersede. Idempotent per
-- (workspace, effect, glob); effect ∈ {add, ignore, read-only}.
INSERT OR IGNORE INTO workspace_constraints (workspace_id, effect, glob)
VALUES ($workspace_id, $effect, $glob);

-- PREP: crud_list_workspace_constraints
SELECT effect, glob FROM workspace_constraints WHERE workspace_id = $workspace_id;

-- PREP: crud_delete_workspace_constraint
-- "remove" a constraint — deleting the row, not a fourth effect.
DELETE FROM workspace_constraints WHERE workspace_id = $workspace_id AND effect = $effect AND glob = $glob;

-- PREP: crud_stamp_origin
-- {§fs-write-surface} — the accept stamps the grantor the blind-write closure proved;
-- set-if-null so a reconcile-stamped row is never overwritten.
UPDATE entries SET membership_origin = $membership_origin WHERE id = $entry_id AND membership_origin IS NULL;
