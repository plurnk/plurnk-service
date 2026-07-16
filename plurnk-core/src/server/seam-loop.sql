-- loop.run RPC queries. SPEC §rpc.

-- PREP: loop_run_next_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM loops WHERE worker_id = $worker_id;

-- PREP: loop_run_insert_loop
INSERT INTO loops (worker_id, sequence, status, prompt)
VALUES ($worker_id, $sequence, 102, $prompt)
RETURNING id;
