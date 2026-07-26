-- PREP: test_cost_insert_turn
INSERT INTO turns (loop_id, sequence, status, packet, usage_cost_usd)
VALUES ($loop_id, $sequence, 200, $packet, $cost_usd)
RETURNING id;

-- PREP: test_cost_run
SELECT cost_usd FROM workers WHERE id = $id;

-- PREP: test_cost_session
SELECT cost_usd FROM workspaces WHERE id = $id;

-- PREP: test_cost_update_turn
UPDATE turns SET usage_cost_usd = $cost_usd WHERE id = $id;
