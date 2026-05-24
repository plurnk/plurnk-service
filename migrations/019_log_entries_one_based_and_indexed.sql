-- INIT: log_entries_one_based_and_indexed
-- Two changes packaged together because they touch the same column shape:
--
-- 1. action_index is now 1-based (was 0-based). Existing rows get bumped
--    by 1 to keep historical addresses stable. The grammar schema's
--    `minimum: 0` still admits 1-based values; a separate grammar issue
--    tightens it to `minimum: 1` and renames the column to `sequence`.
--
-- 2. New `indexed` column on log_entries. Default 1 (visible). The log://
--    scheme grows show/hide ops that toggle this flag — log entries
--    participate in the model's curation surface via URI dispatch, even
--    though they live in a separate table from entries+entry_channels.
UPDATE log_entries SET action_index = action_index + 1;
ALTER TABLE log_entries ADD COLUMN indexed INTEGER NOT NULL DEFAULT 1;
