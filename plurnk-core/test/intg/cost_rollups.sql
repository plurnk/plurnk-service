-- PREP: test_cost_insert_turn
INSERT INTO turns (loop_id, sequence, status, packet)
VALUES ($loop_id, $sequence, 200, $packet)
RETURNING id;

-- PREP: test_cost_worker
SELECT cost_usd FROM workers WHERE id = $id;

-- PREP: test_cost_workspace
SELECT cost_usd FROM workspaces WHERE id = $id;
