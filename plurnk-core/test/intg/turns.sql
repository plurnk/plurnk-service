-- PREP: test_turns_table_sql
SELECT sql FROM sqlite_master WHERE name = 'turns';

-- PREP: test_turns_insert
INSERT INTO turns (loop_id, sequence, status, packet) VALUES ($loop_id, $sequence, $status, $packet);

-- PREP: test_turns_insert_with_version
INSERT INTO turns (loop_id, sequence, status, packet, version) VALUES ($loop_id, $sequence, $status, $packet, $version);

-- PREP: test_turns_insert_with_prompt_budget
-- The turn retains only the latest-packet gauge denominator; provider usage is
-- normalized under provider_requests. {§tokenomics-client-gauge}
INSERT INTO turns (loop_id, sequence, status, packet, usage_prompt_budget)
VALUES ($loop_id, $sequence, $status, $packet, $prompt_budget);

-- PREP: test_turns_get_full
SELECT * FROM turns WHERE loop_id = $loop_id LIMIT 1;

-- PREP: test_turns_get_prompt_budget
SELECT usage_prompt_budget FROM turns WHERE loop_id = $loop_id;

-- PREP: test_turns_count_all
SELECT COUNT(*) AS n FROM turns;

-- PREP: test_turns_list_ids
SELECT id FROM turns WHERE loop_id = $loop_id ORDER BY id;

-- PREP: test_turns_loops_delete
DELETE FROM loops WHERE id = $id;

-- PREP: test_turns_index_meta
SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = $name;

-- PREP: test_turns_insert_missing_loop_id
INSERT INTO turns (sequence, status, packet) VALUES ($sequence, $status, $packet);

-- PREP: test_turns_insert_missing_status
INSERT INTO turns (loop_id, sequence, packet) VALUES ($loop_id, $sequence, $packet);

-- PREP: test_turns_insert_missing_packet
INSERT INTO turns (loop_id, sequence, status) VALUES ($loop_id, $sequence, $status);
