-- #527 {§entry-owner} — entry ownership primitives. Every entry is owned by a worker; the
-- workspace's reserved 'commons' worker owns shared content, the spawning worker owns its
-- capability streams. Owner ids never render — the model addresses owners by NAME (authority).

-- PREP: owner_is_ancestor_or_self
-- {§stream-owner-scoped} — may $reader_id read $owner_id's private surface? Yes iff the reader
-- IS the owner or an ANCESTOR of it (walk parent_worker_id up from the owner; oversight flows
-- down the tree, a child never snoops upward). Finite + acyclic (parent != id CHECK).
WITH RECURSIVE lineage(id, parent_worker_id) AS (
    SELECT id, parent_worker_id FROM workers WHERE id = $owner_id
    UNION ALL
    SELECT w.id, w.parent_worker_id FROM workers w JOIN lineage l ON w.id = l.parent_worker_id
)
SELECT 1 AS permitted FROM lineage WHERE id = $reader_id;
