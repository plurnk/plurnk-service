-- loop.run RPC queries. SPEC §13.

-- PREP: loop_run_next_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM loops WHERE run_id = $run_id;

-- PREP: loop_run_insert_loop
INSERT INTO loops (run_id, sequence, status, prompt, persona)
VALUES ($run_id, $sequence, 102, $prompt, $persona)
RETURNING id;
