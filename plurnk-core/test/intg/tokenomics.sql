-- Token-accounting reads (SPEC §tokenomics). Surface the tokens columns populated
-- at write time so tokenomics.test.ts can assert them directly.

-- PREP: tok_channel_tokens
SELECT tokens FROM entry_channels WHERE entry_id = $entry_id AND name = $name;

-- PREP: tok_log_tokens
SELECT tokens FROM log_entries WHERE id = $id;
