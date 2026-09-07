-- ApplicationPort runLoop queries. SPEC {§methods-loop-run}.

-- PREP: application_list_worker_loops
-- {§methods-worker-loops}: durable lifecycle projection for exterior adapters.
SELECT id, worker_id AS workerId, sequence, status, prompt,
       prompt_source AS promptSource, terminated_at AS terminatedAt,
       terminal_result AS terminalResult,
       scheduled_at, repeat_interval_ms, recurrence_root_loop_id,
       (SELECT COUNT(*)
          FROM turns
         WHERE turns.loop_id = loops.id
           AND turns.packet IS NOT NULL) AS packetCount
FROM loops
WHERE worker_id = $worker_id
ORDER BY sequence;
