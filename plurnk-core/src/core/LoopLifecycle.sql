-- Durable loop lifecycle transitions. LoopLifecycle is the only TypeScript owner
-- of these statements; callers request transitions rather than writing status.

-- PREP: lifecycle_park_loop
UPDATE loops
SET status = 202,
    terminal_message = $message
WHERE id = $loop_id AND status = 102
RETURNING id;

-- PREP: lifecycle_wake_loop
UPDATE loops
SET status = 100
WHERE id = $loop_id AND status = 202
RETURNING id;

-- PREP: lifecycle_finish_loop
UPDATE loops
SET status = $status,
    terminal_message = $message,
    terminated_by = $terminated_by
WHERE id = $loop_id AND status IN (100, 102, 202)
RETURNING id;

-- PREP: lifecycle_loop_status
SELECT status FROM loops WHERE id = $loop_id;

-- PREP: lifecycle_loop_turns
SELECT id FROM turns WHERE loop_id = $loop_id ORDER BY sequence, id;

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
    terminal_message = $message,
    terminated_by = 'cancel'
WHERE worker_id IN (
    SELECT id FROM tree WHERE $include_root = 1 OR id <> $worker_id
)
  AND status IN (100, 102, 202)
RETURNING id AS loop_id, worker_id;
