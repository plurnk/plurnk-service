-- {§entry-owner} — entry ownership primitives. Every entry is owned by a worker; the
-- workspace's reserved 'commons' worker owns shared content, the spawning worker owns its
-- capability streams. Owner ids never render — the model addresses owners by NAME (authority).

-- PREP: owner_shares_workspace
-- {§stream-owner-scoped} {§worker-read-scope} — may $reader_id read $owner_id's named surface?
-- Yes iff both are workers of the same workspace: the parent designs the topology by what it
-- names to whom; the engine imposes none (#394). An unknown name is refused before this runs.
SELECT 1 AS permitted
FROM workers o JOIN workers r ON r.workspace_id = o.workspace_id
WHERE o.id = $owner_id AND r.id = $reader_id;
