-- Durable loop lifecycle transitions. LoopLifecycle is the only TypeScript owner
-- of these statements; callers request transitions rather than writing status.

-- PREP: lifecycle_execution_budget
UPDATE loops SET execution_budget_ms = COALESCE(execution_budget_ms, $budget_ms)
WHERE id = $loop_id AND status = 102
RETURNING worker_id, execution_budget_ms, execution_elapsed_ms;

-- PREP: lifecycle_checkpoint_execution
UPDATE loops SET execution_elapsed_ms = $elapsed_ms WHERE id = $loop_id;

-- PREP: lifecycle_park_loop
UPDATE loops
SET status = 202,
    execution_elapsed_ms = COALESCE($elapsed_ms, execution_elapsed_ms),
    wait_revision = wait_revision + 1,
    wait_deadline_at = $deadline_at,
    wait_poll_interval = $poll_interval,
    wait_poll_at = $poll_at
WHERE id = $loop_id AND status = 102
RETURNING id;

-- PREP: lifecycle_wake_loop
UPDATE loops
SET status = 100,
    wait_deadline_at = NULL,
    wait_poll_interval = NULL,
    wait_poll_at = NULL
WHERE id = $loop_id AND status = 202
  AND ($revision IS NULL OR wait_revision = $revision)
  AND ($due_at IS NULL OR wait_deadline_at <= $due_at OR wait_poll_at <= $due_at)
  AND ($event_only = 0 OR observed_wake_revision < (SELECT wake_revision FROM workers WHERE id = loops.worker_id))
RETURNING id;

-- PREP: lifecycle_parked_loops
SELECT id, wait_revision, wait_deadline_at, wait_poll_interval, wait_poll_at
FROM loops WHERE worker_id = $worker_id AND status = 202
ORDER BY sequence;

-- PREP: lifecycle_set_inherited_poll
UPDATE loops SET wait_poll_at = $poll_at
WHERE id = $loop_id AND status = 202 AND wait_revision = $revision
  AND wait_poll_interval IS NULL AND wait_poll_at IS NULL;

-- PREP: lifecycle_finish_loop
UPDATE loops
SET status = $status,
    execution_elapsed_ms = COALESCE($elapsed_ms, execution_elapsed_ms),
    wait_deadline_at = NULL,
    wait_poll_interval = NULL,
    wait_poll_at = NULL,
    terminal_result = CASE WHEN EXISTS (SELECT 1 FROM loop_responses WHERE loop_id = loops.id)
        THEN json_set($result,
            '$.content', (SELECT content FROM loop_responses WHERE loop_id = loops.id),
            '$.mimetype', 'text/markdown')
        ELSE $result END,
    terminated_by = $terminated_by
WHERE id = $loop_id AND status IN (100, 102, 202)
RETURNING terminal_result;

-- PREP: lifecycle_loop_status
SELECT status, terminal_result FROM loops WHERE id = $loop_id;

-- PREP: lifecycle_loop_turns
SELECT id FROM turns WHERE loop_id = $loop_id ORDER BY sequence, id;

-- PREP: lifecycle_loop_model_turn_count
-- Producer-neutral operation turns are chronology, not inference allowance.
-- Completed inference turns count even when no provider response was admitted.
SELECT COUNT(*) AS count
FROM turns
WHERE loop_id = $loop_id
  AND producer = 'model'
  AND kind = 'inference'
  AND completed_at IS NOT NULL;

-- PREP: lifecycle_worker_tree
WITH RECURSIVE tree(id, depth) AS (
    SELECT id, 0 FROM workers WHERE id = $worker_id
    UNION ALL
    SELECT child.id, tree.depth + 1
    FROM workers child
    JOIN tree ON child.parent_worker_id = tree.id
)
-- CROSS JOIN fixes the nesting: the walked tree is the outer loop and each worker is a
-- primary-key probe, instead of a scan of every worker probing the tree ({§db-fk-indexes}).
SELECT tree.id AS worker_id, tree.depth, workers.cancelled_through_sequence
FROM tree CROSS JOIN workers ON workers.id = tree.id
WHERE $include_root = 1 OR tree.id <> $worker_id
ORDER BY tree.depth DESC, tree.id;

-- TX: lifecycle_cancel_worker_tree
-- {§worker-causal-admission}: the cutoff and cancellation are one durable decision.
UPDATE workers
SET cancelled_through_sequence = MAX(cancelled_through_sequence, COALESCE(
    (SELECT MAX(sequence) FROM loops WHERE worker_id = workers.id), 0
))
WHERE id IN (SELECT value FROM json_each($worker_ids));

UPDATE loops
SET status = 499,
    execution_elapsed_ms = COALESCE((
        SELECT json_extract(value, '$.elapsed_ms') FROM json_each($executions)
        WHERE json_extract(value, '$.loop_id') = loops.id
    ), execution_elapsed_ms),
    wait_deadline_at = NULL,
    wait_poll_interval = NULL,
    wait_poll_at = NULL,
    terminal_result = json_set(
        CASE WHEN EXISTS (SELECT 1 FROM loop_responses WHERE loop_id = loops.id)
            THEN json_set($result,
                '$.content', (SELECT content FROM loop_responses WHERE loop_id = loops.id),
                '$.mimetype', 'text/markdown')
            ELSE $result END,
        '$.problem.instance',
        'loop:///' || id
    ),
    terminated_by = 'cancel'
WHERE worker_id IN (SELECT value FROM json_each($worker_ids))
  AND status IN (100, 102, 202);

-- PREP: lifecycle_cancelled_loops
SELECT loops.id AS loop_id, loops.worker_id, loops.terminal_result FROM loops
JOIN json_each($worker_cutoffs) cutoff ON loops.worker_id = json_extract(cutoff.value, '$.worker_id')
WHERE loops.sequence > json_extract(cutoff.value, '$.cancelled_through_sequence')
  AND loops.status = 499 AND loops.terminated_by = 'cancel'
ORDER BY loops.id;

-- INIT: loops_schedule_successor
-- {§worker-scheduled-send}: settlement and successor admission are one mutation.
-- Claims coalesce elapsed cadence slots; neither prompts nor effects are replayed.
DROP TRIGGER IF EXISTS loops_schedule_successor;
CREATE TRIGGER loops_schedule_successor
AFTER UPDATE OF status ON loops
WHEN NEW.status = 200 AND OLD.status IN (100, 102, 202)
  AND NEW.repeat_interval_ms IS NOT NULL
BEGIN
    INSERT INTO loops (
        worker_id, sequence, status, prompt, prompt_source, policy,
        model_route_id, spawn_model_route_id, reasoning_policy, max_turns,
        execution_budget_ms, open_paths, scheduled_at, repeat_interval_ms, recurrence_root_loop_id
    )
    SELECT NEW.worker_id,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM loops WHERE worker_id = NEW.worker_id),
           100, seed.prompt, seed.prompt_source, seed.policy,
           seed.model_route_id, seed.spawn_model_route_id, seed.reasoning_policy, seed.max_turns,
           seed.execution_budget_ms, seed.open_paths,
           NEW.scheduled_at + NEW.repeat_interval_ms, NEW.repeat_interval_ms, seed.id
    FROM loops seed
    WHERE seed.id = COALESCE(NEW.recurrence_root_loop_id, NEW.id);
END;

-- INIT: loops_stamp_terminated_at
-- {§worker-scheme}: a loop crossing into a terminal status stamps terminated_at, so sibling
-- workers pull the termination as a folded ambient delta — caught uniformly across every
-- death-path (SEND, overflow recovery, max-turns, strike, KILL). The stamp updates terminated_at,
-- never status, so it cannot re-fire this trigger. Terminals: 200 done · 413 budget ·
-- 429 turn-ceiling · 499 cancel · 500 fail · 504 execution timeout · 508 runaway. (202 = parked/sleeping, NOT terminal.)
DROP TRIGGER IF EXISTS loops_stamp_terminated_at;
CREATE TRIGGER loops_stamp_terminated_at
AFTER UPDATE OF status ON loops
WHEN NEW.status IN (200, 413, 429, 499, 500, 504, 508) AND OLD.status NOT IN (200, 413, 429, 499, 500, 504, 508)
BEGIN
    UPDATE loops SET terminated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
