-- Entry CRUD primitives (SPEC §3.2). Used by entry-bearing schemes
-- (known/unknown/skill) and the engine for cross-scheme COPY/MOVE/SEND[410].

-- PREP: crud_find_session_entry
SELECT id FROM entries
WHERE scope = 'session' AND session_id = $session_id AND scheme = $scheme AND pathname = $pathname;

-- PREP: crud_read_channels
SELECT name, content, mimetype FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: crud_read_tags
SELECT tag FROM entry_tags WHERE entry_id = $entry_id ORDER BY tag;

-- PREP: crud_insert_session_entry
INSERT INTO entries (scope, session_id, scheme, pathname)
VALUES ('session', $session_id, $scheme, $pathname)
RETURNING id;

-- PREP: crud_delete_channels
DELETE FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: crud_delete_tags
DELETE FROM entry_tags WHERE entry_id = $entry_id;

-- PREP: crud_write_channel
INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens, state)
VALUES ($entry_id, $name, $content, $mimetype, 0, 'static');

-- PREP: crud_write_visibility
INSERT OR IGNORE INTO visibility (run_id, entry_id, channel, indexed)
VALUES ($run_id, $entry_id, $channel, 1);

-- PREP: crud_write_tag
INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES ($entry_id, $tag);

-- PREP: crud_delete_entry
DELETE FROM entries WHERE id = $entry_id;
