-- PREP: test_entries_table_sql
SELECT sql FROM sqlite_master WHERE name = $name;

-- PREP: test_entries_insert_workspace
INSERT INTO entries (owner_id, scheme, pathname)
SELECT id, $scheme, $pathname
FROM workers
WHERE workspace_id = $workspace_id AND name = 'commons'
RETURNING id;

-- PREP: test_entries_insert_workspace_coordinate
INSERT INTO entries (owner_id, scheme, authority, pathname)
SELECT id, $scheme, $authority, $pathname
FROM workers
WHERE workspace_id = $workspace_id AND name = 'commons'
RETURNING id;

-- PREP: test_entries_get_first
SELECT e.id, e.version, owner.workspace_id, e.owner_id, e.scheme, e.authority, e.pathname, e.attributes
FROM entries e JOIN workers owner ON owner.id = e.owner_id
LIMIT 1;

-- PREP: test_entries_get_first_identity
SELECT owner.workspace_id, e.owner_id
FROM entries e JOIN workers owner ON owner.id = e.owner_id
LIMIT 1;

-- PREP: test_entries_insert_with_owner_id_only
INSERT INTO entries (owner_id, scheme, pathname) VALUES ($owner_id, 'x', $pathname);

-- PREP: test_entries_insert_with_attributes
INSERT INTO entries (owner_id, scheme, pathname, attributes)
VALUES ((SELECT id FROM workers WHERE name = 'commons' ORDER BY id LIMIT 1), 'x', $pathname, $attributes);

-- PREP: test_entries_count_all
SELECT COUNT(*) AS n FROM entries;

-- PREP: test_entries_get_scheme
SELECT scheme FROM entries LIMIT 1;

-- PREP: test_entries_get_authority
SELECT authority FROM entries LIMIT 1;

-- PREP: test_entries_get_attributes
SELECT attributes FROM entries LIMIT 1;

-- PREP: test_entries_get_pathname
SELECT pathname FROM entries LIMIT 1;

-- PREP: test_entries_partial_indexes
SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'entries_%';

-- PREP: test_entry_channels_insert_default
INSERT INTO entry_channels (entry_id, name, content, mimetype) VALUES ($entry_id, $name, $content, $mimetype);

-- PREP: test_entry_channels_insert_with_state
INSERT INTO entry_channels (entry_id, name, content, mimetype, state) VALUES ($entry_id, $name, $content, $mimetype, $state);

-- PREP: test_entry_channels_insert_with_weight
INSERT INTO entry_channels (entry_id, name, content, mimetype, weight) VALUES ($entry_id, $name, $content, $mimetype, $weight);

-- PREP: test_entry_channels_insert_with_producer_result
INSERT INTO entry_channels (entry_id, name, content, mimetype, producer_result)
VALUES ($entry_id, $name, $content, $mimetype, $producer_result);

-- PREP: test_entry_channels_get_first
SELECT entry_id, name, content, mimetype, weight, state, producer_result FROM entry_channels WHERE entry_id = $entry_id LIMIT 1;

-- PREP: test_entry_channels_count_all
SELECT COUNT(*) AS n FROM entry_channels;

-- EXEC: test_entries_insert_no_owner
INSERT INTO entries (scheme, pathname) VALUES ('x', '/x');



-- EXEC: test_entries_insert_empty_scheme
INSERT INTO entries (owner_id, scheme, pathname) VALUES ((SELECT id FROM workers ORDER BY id LIMIT 1), '', '/x');

-- EXEC: test_entries_insert_no_pathname
INSERT INTO entries (owner_id, scheme) VALUES ((SELECT id FROM workers ORDER BY id LIMIT 1), 'x');

-- EXEC: test_entries_insert_null_authority
INSERT INTO entries (owner_id, scheme, authority, pathname)
VALUES ((SELECT id FROM workers ORDER BY id LIMIT 1), 'x', NULL, '/x');

-- PREP: test_entry_channels_insert_missing_name
INSERT INTO entry_channels (entry_id, content, mimetype) VALUES ($entry_id, '', 'text/plain');

-- PREP: test_entry_channels_insert_missing_content
INSERT INTO entry_channels (entry_id, name, mimetype) VALUES ($entry_id, 'body', 'text/plain');

-- PREP: test_entry_channels_insert_missing_mimetype
INSERT INTO entry_channels (entry_id, name, content) VALUES ($entry_id, 'body', '');
