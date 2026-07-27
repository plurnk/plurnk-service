-- PREP: test_loops_table_sql
SELECT sql FROM sqlite_master WHERE name = 'loops';

-- PREP: test_loops_insert
INSERT INTO loops (worker_id, sequence, prompt) VALUES ($worker_id, $sequence, $prompt);

-- PREP: test_loops_insert_with_status
INSERT INTO loops (worker_id, sequence, status, prompt, terminal_result)
VALUES ($worker_id, $sequence, $status, $prompt, $terminal_result);

-- PREP: test_loops_insert_with_version
INSERT INTO loops (worker_id, sequence, version, prompt) VALUES ($worker_id, $sequence, $version, $prompt);

-- PREP: test_loops_get_by_run
SELECT id, version, worker_id, sequence, status, prompt FROM loops WHERE worker_id = $worker_id LIMIT 1;

-- PREP: test_loops_statuses_by_run
SELECT status FROM loops WHERE worker_id = $worker_id ORDER BY sequence;

-- PREP: test_loops_count
SELECT COUNT(*) AS n FROM loops;

-- PREP: test_loops_index_meta
SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'loops_worker_id_sequence';

-- PREP: test_loops_list_ids
SELECT id FROM loops WHERE worker_id = $worker_id ORDER BY id;

-- PREP: test_loops_get_prompt
SELECT prompt FROM loops WHERE worker_id = $worker_id LIMIT 1;

-- PREP: test_loops_get_attributions
SELECT attributions FROM loops WHERE id = $loop_id;

-- EXEC: test_loops_insert_no_worker_id
INSERT INTO loops (sequence, prompt) VALUES (1, 'x');
