-- Curation-weight reads (SPEC {§tokenomics}). Surface the weight columns
-- populated at write time so tokenomics.test.ts can assert them directly.

-- PREP: tok_channel_weight
SELECT weight FROM entry_channels WHERE entry_id = $entry_id AND name = $name;

-- PREP: tok_log_weight
SELECT op, attrs, tx, mimetype_tx, rx, mimetype_rx, weight
FROM log_entries WHERE id = $id;
