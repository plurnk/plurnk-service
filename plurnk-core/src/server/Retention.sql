-- Retention ({§retention-policy}): the operator's policy over what the database keeps, as set
-- statements run by Retention on the daemon's cadence and at shutdown. Under the defaults nothing
-- that is information leaves; only what no row references.

-- PREP: retention_retire_packets
-- A completed turn older than the policy — beyond the newest $keep_turns packet-bearing turns of
-- its loop, or completed more than $keep_ms before $now_ms — loses its packet composition. The
-- turn, its bag, its log rows and its accounting stay; -1 on both disables the statement.
DELETE FROM turn_sections
WHERE ($keep_turns >= 0 OR $keep_ms >= 0)
  AND turn_id IN (
      SELECT t.id FROM turns t
      WHERE t.completed_at IS NOT NULL AND t.packet IS NOT NULL
        AND (
            ($keep_turns >= 0 AND (
                SELECT COUNT(*) FROM turns newer
                WHERE newer.loop_id = t.loop_id AND newer.packet IS NOT NULL AND newer.sequence > t.sequence
            ) >= $keep_turns)
            OR ($keep_ms >= 0 AND unixepoch(t.completed_at) * 1000 < $now_ms - $keep_ms)
        )
  );

-- PREP: retention_retire_responses
-- A settled call's response body beyond the newest $keep_turns body-bearing calls of its loop,
-- or whose turn completed more than $keep_ms before $now_ms, retires; the call's identity,
-- failure, capacity, admission and accounting stay, and the digest renders it request-only.
-- -1 on both disables the statement; a call on an open turn is never retired.
DELETE FROM model_call_responses
WHERE ($keep_turns >= 0 OR $keep_ms >= 0)
  AND id IN (
      SELECT ic.id FROM inference_calls ic
      JOIN turns t ON t.id = ic.turn_id
      WHERE t.completed_at IS NOT NULL
        AND (
            ($keep_turns >= 0 AND (
                SELECT COUNT(*) FROM inference_calls newer
                JOIN turns nt ON nt.id = newer.turn_id
                WHERE nt.loop_id = t.loop_id
                  AND EXISTS (SELECT 1 FROM model_call_responses r WHERE r.id = newer.id)
                  AND (nt.sequence > t.sequence OR (nt.sequence = t.sequence AND newer.sequence > ic.sequence))
            ) >= $keep_turns)
            OR ($keep_ms >= 0 AND unixepoch(t.completed_at) * 1000 < $now_ms - $keep_ms)
        )
  );

-- PREP: retention_collect_packet_items
-- {§packet-items}: an item no turn's composition references is transient data.
DELETE FROM packet_items
WHERE $collect = 1
  AND NOT EXISTS (SELECT 1 FROM turn_section_items tsi WHERE tsi.item_hash = packet_items.hash);

-- PREP: retention_collect_derivations
-- A derivation no channel, turn source, or log row cites is transient data; its symbols cascade
-- and derivations_delete_fts drops its full-text shadow.
DELETE FROM derivations
WHERE $collect = 1
  AND NOT EXISTS (SELECT 1 FROM entry_channels c WHERE c.deep_hash = derivations.deep_hash)
  AND NOT EXISTS (SELECT 1 FROM turn_sources s WHERE s.deep_hash = derivations.deep_hash)
  AND NOT EXISTS (SELECT 1 FROM log_entries le WHERE le.deep_hash = derivations.deep_hash);

-- {§db-space-reclamation} The daemon keeps its own file healthy: freed pages go back to the OS.

-- PREP: retention_auto_vacuum_mode
PRAGMA auto_vacuum;

-- EXEC: retention_convert_incremental
-- An auto_vacuum setter acts when SQLite PREPARES it, so a prepared setter would change the mode
-- of whichever VACUUM runs next; executed here it pairs with its own VACUUM, which applies it.
PRAGMA auto_vacuum = INCREMENTAL;
VACUUM;

-- EXEC: retention_convert_none
PRAGMA auto_vacuum = NONE;
VACUUM;

-- PREP: retention_page_counts
SELECT (SELECT page_count FROM pragma_page_count()) AS pages,
       (SELECT freelist_count FROM pragma_freelist_count()) AS free,
       (SELECT page_size FROM pragma_page_size()) AS pageSize;

-- PREP: retention_incremental_vacuum
PRAGMA incremental_vacuum;
