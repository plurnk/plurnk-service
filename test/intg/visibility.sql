-- PREP: test_visibility_table_sql
SELECT sql FROM sqlite_master WHERE name = 'visibility';

-- PREP: test_visibility_insert_agent_entry
INSERT INTO entries (scope, scheme, pathname) VALUES ('agent', $scheme, $pathname) RETURNING id;

-- PREP: test_visibility_insert_default
INSERT INTO visibility (run_id, entry_id, channel) VALUES ($run_id, $entry_id, $channel);

-- PREP: test_visibility_insert_with_indexed
INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES ($run_id, $entry_id, $channel, $indexed);

-- PREP: test_visibility_get_first
SELECT indexed FROM visibility WHERE run_id = $run_id AND entry_id = $entry_id LIMIT 1;

-- PREP: test_visibility_count_all
SELECT COUNT(*) AS n FROM visibility;

-- PREP: test_visibility_by_run_entry
SELECT channel, indexed FROM visibility WHERE run_id = $run_id AND entry_id = $entry_id ORDER BY channel;

-- PREP: test_visibility_indexed_by_run
SELECT entry_id FROM visibility WHERE run_id = $run_id AND indexed = 1 ORDER BY entry_id;

-- PREP: test_visibility_delete_entry
DELETE FROM entries WHERE id = $id;

-- PREP: test_visibility_insert_missing_run_id
INSERT INTO visibility (entry_id, channel) VALUES ($entry_id, $channel);

-- PREP: test_visibility_insert_missing_entry_id
INSERT INTO visibility (run_id, channel) VALUES ($run_id, $channel);

-- PREP: test_visibility_insert_missing_channel
INSERT INTO visibility (run_id, entry_id) VALUES ($run_id, $entry_id);
