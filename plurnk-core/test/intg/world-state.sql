-- WorldState invariant queries ({§fs-world-state}) — the pure-db half of the harness.
-- Read-only; integration and demo harnesses run these checks over their specimens.

-- PREP: ws_dup_identities
-- {§entry-identity-no-null} in PRACTICE: no two rows may share the identity tuple. The
-- UNIQUE index should make this impossible; the harness asserts the world, not the intent.
SELECT workspace_id, owner_id, scheme, authority, pathname, COUNT(*) AS n
FROM entries GROUP BY workspace_id, owner_id, scheme, authority, pathname HAVING n > 1;

-- PREP: ws_file_keys
-- {§fs-canonical-name} fixpoint inputs: every file-class key with its workspace root.
SELECT e.workspace_id, e.pathname, w.project_root
FROM entries e JOIN workspaces w ON w.id = e.workspace_id
WHERE e.scheme = 'file';

-- PREP: ws_orphan_channels
SELECT COUNT(*) AS n FROM entry_channels c LEFT JOIN entries e ON e.id = c.entry_id WHERE e.id IS NULL;

-- PREP: ws_alien_origin
-- The closed admission set ({§fs-write-surface}): Git and constraint are the only
-- represented file-membership grantors.
SELECT workspace_id, pathname, membership_origin FROM entries
WHERE scheme = 'file' AND membership_origin IS NOT NULL
  AND membership_origin NOT IN ('git', 'constraint');

-- PREP: ws_sig_on_nonfile
-- synced_sig is the file-class disk gate; on any other scheme it is machinery leaking.
SELECT COUNT(*) AS n FROM entries WHERE scheme != 'file' AND synced_sig IS NOT NULL;

-- PREP: ws_entry_count
SELECT COUNT(*) AS n FROM entries;
