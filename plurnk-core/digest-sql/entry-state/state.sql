-- PREP: digest_entry_semantic_state
SELECT COUNT(*) AS channel_entries,
       COUNT(e.deep_hash) AS derivation_complete,
       COUNT(*) - COUNT(e.deep_hash) AS unfinished
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body';
