-- INIT: drop_preview_channel
-- Preview is a render-time output of `Mimetypes.process()`, not a stored
-- channel. The earlier "v0 verbatim copy of body" placeholder is removed;
-- this drops any existing preview rows so subsequent renders can't reach
-- stale-but-indexed preview content.
DELETE FROM entry_channels WHERE name = 'preview';
DELETE FROM visibility    WHERE channel = 'preview';
