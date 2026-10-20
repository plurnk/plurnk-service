-- ApplicationPort runLoop queries. SPEC {§methods-loop-run}.

-- PREP: application_latest_concluded_loop
-- {§methods-worker-gauge}: the work loop that concluded last, the one whose terminal reported the worker's gauge.
SELECT id FROM work_loops
WHERE worker_id = $worker_id AND terminated_at IS NOT NULL
ORDER BY terminated_at DESC, sequence DESC
LIMIT 1;

-- PREP: application_list_worker_loops
-- {§methods-worker-loops}: durable lifecycle projection for exterior adapters. {§worker-obligations}: a loop is
-- opened by its first message's operation, named in the sender's own log.
SELECT loops.id, loops.worker_id AS workerId, loops.sequence, loops.status, loops.prompt,
       loops.prompt_source AS promptSource, loops.claimed_at AS claimedAt, loops.terminated_at AS terminatedAt,
       loops.terminal_result AS terminalResult, loops.wait_poll_at AS waitUntil,
       (SELECT COUNT(*)
          FROM turns
         WHERE turns.loop_id = loops.id
           AND turns.packet IS NOT NULL) AS packetCount,
       sender.worker_id AS invocationWorkerId,
       CASE WHEN o.id IS NULL THEN NULL
            ELSE printf('log:///%d/%d/%d/%s', sender.sequence, opened.sequence, o.sequence, o.op) END AS invocation
FROM work_loops AS loops
LEFT JOIN loop_messages first ON first.loop_id = loops.id AND first.ordinal = 1
LEFT JOIN turns opened ON opened.id = first.opened_turn_id
LEFT JOIN loops sender ON sender.id = opened.loop_id
LEFT JOIN log_entries o ON o.turn_id = first.opened_turn_id AND o.sequence = first.opened_sequence
WHERE loops.worker_id = $worker_id
ORDER BY loops.sequence;
