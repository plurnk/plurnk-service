-- ApplicationPort runLoop queries. SPEC {§methods-loop-run}.

-- PREP: loop_run_next_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM loops WHERE worker_id = $worker_id;

-- PREP: loop_run_insert_loop
INSERT INTO loops (worker_id, sequence, status, prompt)
VALUES ($worker_id, $sequence, 102, $prompt)
RETURNING id;

-- PREP: application_list_worker_loops
-- {§methods-worker-loops}: durable lifecycle projection for exterior adapters.
SELECT id, worker_id AS workerId, sequence, status, prompt,
       prompt_source AS promptSource, terminated_at AS terminatedAt,
       terminal_result AS terminalResult,
       (SELECT COUNT(*)
          FROM turns
         WHERE turns.loop_id = loops.id
           AND turns.packet IS NOT NULL) AS packetCount
FROM loops
WHERE worker_id = $worker_id
ORDER BY sequence;
