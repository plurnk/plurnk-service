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
    terminal_result = $result,
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
SELECT id AS worker_id, depth
FROM tree
WHERE $include_root = 1 OR id <> $worker_id
ORDER BY depth DESC, id;

-- PREP: lifecycle_cancel_worker_tree
WITH RECURSIVE tree(id) AS (
    SELECT id FROM workers WHERE id = $worker_id
    UNION ALL
    SELECT child.id
    FROM workers child
    JOIN tree ON child.parent_worker_id = tree.id
)
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
        $result,
        '$.problem.instance',
        'loop:///' || id
    ),
    terminated_by = 'cancel'
WHERE worker_id IN (
    SELECT id FROM tree WHERE $include_root = 1 OR id <> $worker_id
)
  AND status IN (100, 102, 202)
RETURNING id AS loop_id, worker_id, terminal_result;
