-- SearchIndex: the workspace's entries as derivation candidates.

-- PREP: search_index_entry_candidates
-- {§derivation-dedup-parallel} — the maintenance pass judges an entry channel from stored
-- identity: no body crosses into the process here. `content_length` is SQLite's own count.
SELECT e.id AS entry_id, e.scheme, e.authority, e.pathname, ec.name AS channel, ec.mimetype,
    length(ec.content) AS content_length, ec.content_hash, ec.deep_hash
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.workspace_id = $workspace_id
  AND ec.content IS NOT NULL
ORDER BY e.updated_at ASC, e.id ASC, ec.name;

-- PREP: search_index_entry_body
-- One body, acquired only when its derivation runs, and only while the channel still denotes
-- the representation the pass judged; a representation that moved on returns no row and is
-- judged again by the next pass ({§derivation-dedup-parallel}).
SELECT content FROM entry_channels
WHERE entry_id = $entry_id AND name = $channel AND content_hash IS $content_hash;
