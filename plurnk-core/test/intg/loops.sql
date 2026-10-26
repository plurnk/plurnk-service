-- PREP: test_loops_table_sql
SELECT sql FROM sqlite_master WHERE name = 'loops';

-- PREP: test_loops_insert
INSERT INTO loops (session_id, sequence, prompt, max_turns)
VALUES ($session_id, $sequence, $prompt, -1);

-- PREP: test_loops_insert_with_status
INSERT INTO loops (session_id, sequence, status, prompt, terminal_result, max_turns)
VALUES ($session_id, $sequence, $status, $prompt, $terminal_result, -1);

-- PREP: test_loops_insert_with_version
INSERT INTO loops (session_id, sequence, version, prompt, max_turns)
VALUES ($session_id, $sequence, $version, $prompt, -1);

-- PREP: test_loops_get_by_session
SELECT id, version, session_id, sequence, status, prompt FROM loops WHERE session_id = $session_id LIMIT 1;

-- PREP: test_loops_statuses_by_session
SELECT status FROM loops WHERE session_id = $session_id ORDER BY sequence;

-- PREP: test_loops_count
SELECT COUNT(*) AS n FROM loops;

-- PREP: test_loops_index_meta
SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'loops_session_id_sequence';

-- PREP: test_loops_list_ids
SELECT id FROM loops WHERE session_id = $session_id ORDER BY id;

-- PREP: test_loops_get_prompt
SELECT prompt FROM loops WHERE session_id = $session_id LIMIT 1;

-- EXEC: test_loops_insert_no_session_id
INSERT INTO loops (sequence, prompt, max_turns) VALUES (1, 'x', -1);
