-- PREP: test_cost_insert_turn
INSERT INTO turns (loop_id, sequence, status, packet, usage_cost_pico)
VALUES ($loop_id, $sequence, 200, $packet, $cost_pico)
RETURNING id;

-- PREP: test_cost_run
SELECT cost_pico FROM runs WHERE id = $id;

-- PREP: test_cost_session
SELECT cost_pico FROM sessions WHERE id = $id;

-- PREP: test_cost_update_turn
UPDATE turns SET usage_cost_pico = $cost_pico WHERE id = $id;
