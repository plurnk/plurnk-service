-- PREP: test_parser_entries_first
SELECT scope, scheme, pathname, hostname FROM entries LIMIT 1;

-- PREP: test_parser_body_first
SELECT content FROM entry_channels WHERE name = 'body' LIMIT 1;

-- PREP: test_parser_tags
SELECT tag FROM entry_tags ORDER BY tag;

-- PREP: test_parser_pathnames
SELECT pathname FROM entries ORDER BY pathname;

-- PREP: test_parser_log_indices
SELECT action_index, pathname FROM log_entries ORDER BY action_index;

-- PREP: test_parser_log_first
SELECT scheme, hostname, pathname, params, fragment FROM log_entries LIMIT 1;
