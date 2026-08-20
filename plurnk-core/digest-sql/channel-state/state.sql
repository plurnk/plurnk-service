-- PREP: digest_channel_semantic_state
SELECT COUNT(*) AS channel_entries,
       COUNT(ec.deep_hash) AS derivation_complete,
       COUNT(*) - COUNT(ec.deep_hash) AS unfinished
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id;
