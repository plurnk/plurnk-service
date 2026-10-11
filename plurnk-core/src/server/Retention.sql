-- Retention ({§retention-policy}): the operator's policy over what the database keeps, as set
-- statements run by Retention on the daemon's cadence and at shutdown. Packet compositions and
-- payloads expire independently of durable identities, decisions and accounting.

-- INIT: inference_payload_retirement
DROP TRIGGER IF EXISTS inference_payload_retirement;
CREATE TRIGGER inference_payload_retirement
AFTER UPDATE OF payloads_retired_at ON inference_calls
BEGIN
    DELETE FROM model_call_responses WHERE id = NEW.id;
    UPDATE provider_requests SET evidence = NULL
    WHERE inference_call_id = NEW.id AND evidence IS NOT NULL;
END;

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
-- Rank logical calls, not physical retries. Already retired calls retain their place
-- in that chronology; failed-only captures count too. Open work never expires.
WITH ranked AS MATERIALIZED (
    SELECT ic.id, ic.state, t.completed_at, ic.payloads_retired_at,
           row_number() OVER (PARTITION BY t.loop_id ORDER BY t.sequence DESC, ic.sequence DESC) AS ordinal
    FROM inference_calls ic JOIN turns t ON t.id = ic.turn_id
    WHERE ($keep_turns >= 0 OR $keep_ms >= 0)
      AND (ic.payloads_retired_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM model_call_responses r WHERE r.id = ic.id)
           OR EXISTS (SELECT 1 FROM provider_requests pr WHERE pr.inference_call_id = ic.id AND pr.evidence IS NOT NULL))
)
UPDATE inference_calls SET payloads_retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', $now_ms / 1000.0, 'unixepoch')
WHERE id IN (
    SELECT id FROM ranked
    WHERE payloads_retired_at IS NULL AND state <> 'pending' AND completed_at IS NOT NULL
      AND (($keep_turns >= 0 AND ordinal > $keep_turns)
        OR ($keep_ms >= 0 AND unixepoch(completed_at) * 1000 < $now_ms - $keep_ms))
)
AND NOT EXISTS (SELECT 1 FROM provider_requests pr WHERE pr.inference_call_id = inference_calls.id AND pr.state = 'pending');

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
  AND NOT EXISTS (SELECT 1 FROM entry_channel_rows c WHERE c.deep_hash = derivations.deep_hash)
  AND NOT EXISTS (SELECT 1 FROM turn_sources s WHERE s.deep_hash = derivations.deep_hash)
  AND NOT EXISTS (SELECT 1 FROM log_entries le WHERE le.deep_hash = derivations.deep_hash);

-- PREP: retention_collect_contents
-- {§content-store}: a body no channel holds and no derivation indexes is transient data. Runs
-- after the collectors above, which release what they held.
DELETE FROM contents
WHERE $collect = 1
  AND NOT EXISTS (SELECT 1 FROM entry_channel_rows r WHERE r.content_id = contents.id)
  AND NOT EXISTS (SELECT 1 FROM derivations d WHERE d.content_id = contents.id);

-- PREP: retention_collect_native_contents
-- {§native-content-lifetime}: curation flags never determine evidence ownership.
DELETE FROM native_contents
WHERE $collect = 1
  AND hash NOT IN (
      SELECT native_content_hash FROM log_entries WHERE native_content_hash IS NOT NULL
      UNION
      SELECT json_extract(a.value, '$.contentHash') FROM log_entries le,
          json_each(CASE WHEN le.mimetype_rx = 'application/json' THEN le.rx ELSE '{}' END, '$.attachments') a
      WHERE le.mimetype_rx = 'application/json' AND json_type(a.value, '$.contentHash') = 'text'
      UNION
      SELECT json_extract(a.value, '$.contentHash') FROM loop_messages m, json_each(m.evidence, '$.attachments') a
      WHERE json_type(a.value, '$.contentHash') = 'text'
      UNION
      SELECT json_extract(a.value, '$.contentHash') FROM turns t, json_each(t.packet, '$.attachments') a
      WHERE json_type(a.value, '$.contentHash') = 'text'
  );

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

-- PREP: retention_wal_truncate
-- {§db-space-reclamation} Reclaiming pages while the WAL stays at its high-water mark is half the
-- job. With a reader still attached this reports busy and truncates on a later pass, never blocks.
PRAGMA wal_checkpoint(TRUNCATE);
