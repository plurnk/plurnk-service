-- PREP: test_entries_table_sql
SELECT sql FROM sqlite_master WHERE name = $name;

-- PREP: test_entries_insert_session
INSERT INTO entries (scope, workspace_id, scheme, pathname) VALUES ('workspace', $workspace_id, $scheme, $pathname) RETURNING id;

-- PREP: test_entries_get_first
SELECT id, version, scope, workspace_id, scheme, pathname, attributes FROM entries LIMIT 1;

-- PREP: test_entries_get_first_scope_session
SELECT scope, workspace_id FROM entries LIMIT 1;

-- PREP: test_entries_insert_with_workspace_id_only
INSERT INTO entries (scope, workspace_id, pathname) VALUES ('workspace', $workspace_id, $pathname);

-- PREP: test_entries_insert_with_port
INSERT INTO entries (scope, workspace_id, scheme, hostname, port, pathname) VALUES ('workspace', (SELECT id FROM workspaces ORDER BY id LIMIT 1), $scheme, $hostname, $port, $pathname);

-- PREP: test_entries_insert_with_params
INSERT INTO entries (scope, workspace_id, pathname, params) VALUES ('workspace', (SELECT id FROM workspaces ORDER BY id LIMIT 1), $pathname, $params);

-- PREP: test_entries_insert_with_attributes
INSERT INTO entries (scope, workspace_id, pathname, attributes) VALUES ('workspace', (SELECT id FROM workspaces ORDER BY id LIMIT 1), $pathname, $attributes);

-- PREP: test_entries_count_all
SELECT COUNT(*) AS n FROM entries;

-- PREP: test_entries_get_scheme
SELECT scheme FROM entries LIMIT 1;

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

-- PREP: test_entry_channels_insert_with_tokens
INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens) VALUES ($entry_id, $name, $content, $mimetype, $tokens);

-- PREP: test_entry_channels_get_first
SELECT entry_id, name, content, mimetype, tokens, state FROM entry_channels WHERE entry_id = $entry_id LIMIT 1;

-- PREP: test_entry_channels_count_all
SELECT COUNT(*) AS n FROM entry_channels;

-- PREP: test_entry_tags_insert
INSERT INTO entry_tags (entry_id, tag) VALUES ($entry_id, $tag);

-- PREP: test_entry_tags_count_all
SELECT COUNT(*) AS n FROM entry_tags;

-- PREP: test_entry_tags_by_tag
SELECT entry_id FROM entry_tags WHERE tag = $tag ORDER BY entry_id;

-- PREP: test_entry_tags_index
SELECT name FROM sqlite_master WHERE type='index' AND name='entry_tags_tag';

-- EXEC: test_entries_insert_session_no_workspace_id
INSERT INTO entries (scope, pathname) VALUES ('workspace', '/x');

-- EXEC: test_entries_insert_bad_scope
INSERT INTO entries (scope, pathname) VALUES ('global', '/x');

-- EXEC: test_entries_insert_empty_scheme
INSERT INTO entries (scope, workspace_id, scheme, pathname) VALUES ('workspace', (SELECT id FROM workspaces ORDER BY id LIMIT 1), '', '/x');

-- EXEC: test_entries_insert_no_pathname
INSERT INTO entries (scope, workspace_id) VALUES ('workspace', (SELECT id FROM workspaces ORDER BY id LIMIT 1));

-- PREP: test_entry_channels_insert_missing_name
INSERT INTO entry_channels (entry_id, content, mimetype) VALUES ($entry_id, '', 'text/plain');

-- PREP: test_entry_channels_insert_missing_content
INSERT INTO entry_channels (entry_id, name, mimetype) VALUES ($entry_id, 'body', 'text/plain');

-- PREP: test_entry_channels_insert_missing_mimetype
INSERT INTO entry_channels (entry_id, name, content) VALUES ($entry_id, 'body', '');
