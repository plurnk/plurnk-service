-- PREP: test_turns_table_sql
SELECT sql FROM sqlite_master WHERE name = 'turns';

-- PREP: test_turns_insert
INSERT INTO turns (loop_id, sequence, status, packet) VALUES ($loop_id, $sequence, $status, $packet);

-- PREP: test_turns_insert_with_version
INSERT INTO turns (loop_id, sequence, status, packet, version) VALUES ($loop_id, $sequence, $status, $packet, $version);

-- PREP: test_turns_insert_with_usage_prompt
INSERT INTO turns (loop_id, sequence, status, packet, usage_prompt) VALUES ($loop_id, $sequence, $status, $packet, $val);

-- PREP: test_turns_insert_with_prompt_and_context_size
-- #274 — a turn carrying both window occupancy (usage_prompt) and the model's window (usage_prompt_budget).
INSERT INTO turns (loop_id, sequence, status, packet, usage_prompt, usage_prompt_budget) VALUES ($loop_id, $sequence, $status, $packet, $prompt, $context_size);

-- PREP: test_turns_insert_with_usage_completion
INSERT INTO turns (loop_id, sequence, status, packet, usage_completion) VALUES ($loop_id, $sequence, $status, $packet, $val);

-- PREP: test_turns_insert_with_usage_cached
INSERT INTO turns (loop_id, sequence, status, packet, usage_cached) VALUES ($loop_id, $sequence, $status, $packet, $val);

-- PREP: test_turns_insert_with_usage_cost_pico
INSERT INTO turns (loop_id, sequence, status, packet, usage_cost_pico) VALUES ($loop_id, $sequence, $status, $packet, $val);

-- PREP: test_turns_insert_all_usage
INSERT INTO turns (loop_id, sequence, status, packet, usage_prompt, usage_completion, usage_cached, usage_cost_pico)
VALUES ($loop_id, $sequence, $status, $packet, $usage_prompt, $usage_completion, $usage_cached, $usage_cost_pico);

-- PREP: test_turns_get_full
SELECT * FROM turns WHERE loop_id = $loop_id LIMIT 1;

-- PREP: test_turns_get_usage
SELECT usage_prompt, usage_completion, usage_cached, usage_cost_pico FROM turns WHERE loop_id = $loop_id;

-- PREP: test_turns_sum_cost
SELECT SUM(usage_cost_pico) AS total FROM turns WHERE loop_id = $loop_id;

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
