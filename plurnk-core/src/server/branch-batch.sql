-- {§worker-branch-batch}: durable serialized Git branch batches.

-- PREP: branch_batch_by_turn
SELECT id, state
FROM branch_batches
WHERE parent_turn_id = $parent_turn_id;

-- PREP: branch_batch_insert
INSERT INTO branch_batches (
    workspace_id, parent_worker_id, parent_loop_id, parent_turn_id
) VALUES (
    $workspace_id, $parent_worker_id, $parent_loop_id, $parent_turn_id
)
RETURNING id;

-- PREP: branch_batch_next_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next
FROM branch_batch_items
WHERE batch_id = $batch_id;

-- PREP: branch_batch_insert_item
INSERT INTO branch_batch_items (
    batch_id, sequence, worker_id, loop_id, branch
) VALUES (
    $batch_id, $sequence, $worker_id, $loop_id, $branch
)
RETURNING id;

-- PREP: branch_batch_seal
UPDATE branch_batches
SET state = 'queued'
WHERE parent_turn_id = $parent_turn_id AND state = 'collecting'
RETURNING id, workspace_id, parent_worker_id;

-- PREP: branch_batch_start
UPDATE branch_batches
SET state = 'running',
    repository_path = $repository_path,
    original_ref = $original_ref,
    original_commit = $original_commit
WHERE id = $batch_id AND state = 'queued';

-- PREP: branch_batch_reset_preflight
UPDATE branch_batches
SET repository_path = NULL,
    original_ref = NULL,
    original_commit = NULL
WHERE id = $batch_id AND state = 'queued';

-- PREP: branch_batch_items
SELECT id, sequence, worker_id, loop_id, branch, state,
       result_commit, changed
FROM branch_batch_items
WHERE batch_id = $batch_id
ORDER BY sequence;

-- PREP: branch_batch_start_item
UPDATE branch_batch_items
SET state = 'running',
    started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = $item_id AND state = 'queued';

-- PREP: branch_batch_set_active
UPDATE branch_batches
SET active_sequence = $sequence
WHERE id = $batch_id AND state = 'running';

-- PREP: branch_batch_record_tip
UPDATE branch_batch_items
SET result_commit = $result_commit,
    changed = $changed
WHERE id = $item_id AND result_commit IS NULL;

-- PREP: branch_batch_finish_item
UPDATE branch_batch_items
SET state = $state,
    result = $result,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = $item_id;

-- PREP: branch_batch_finish
UPDATE branch_batches
SET state = $state,
    active_sequence = NULL,
    problem = $problem,
    completed_at = CASE
        WHEN $state IN ('completed', 'failed') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ELSE NULL
    END
WHERE id = $batch_id;

-- PREP: branch_batch_active_for_worker
SELECT b.id AS batch_id, b.state, b.repository_path, i.branch
FROM branch_batches b
JOIN branch_batch_items i ON i.batch_id = b.id
WHERE i.worker_id = $worker_id
  AND b.state = 'running'
  AND i.state = 'running'
  AND b.active_sequence = i.sequence
LIMIT 1;

-- PREP: branch_batch_active
SELECT id, workspace_id, parent_worker_id, parent_loop_id, parent_turn_id,
       state, active_sequence, repository_path, original_ref, original_commit,
       problem
FROM branch_batches
WHERE state IN ('collecting', 'queued', 'running', 'recovery_required')
ORDER BY id;

-- PREP: branch_batch_receipt
SELECT b.id AS batch_id, b.state AS batch_state, i.sequence, i.worker_id,
       i.loop_id, i.branch, i.state AS item_state, i.result,
       i.result_commit, i.changed
FROM branch_batches b
JOIN branch_batch_items i ON i.batch_id = b.id
WHERE b.id = $batch_id
ORDER BY i.sequence;

-- PREP: branch_batch_receipt_for_worker
WITH latest AS (
    SELECT b.id
    FROM branch_batches b
    JOIN branch_batch_items i ON i.batch_id = b.id
    WHERE i.worker_id = $worker_id
      AND b.state IN ('completed', 'failed')
    ORDER BY b.id DESC
    LIMIT 1
)
SELECT b.id AS batch_id, b.state AS batch_state, i.branch,
       i.state AS item_state, i.result, i.result_commit, i.changed
FROM latest
JOIN branch_batches b ON b.id = latest.id
JOIN branch_batch_items i ON i.batch_id = b.id AND i.worker_id = $worker_id;

-- PREP: branch_batch_worker_lineage
WITH RECURSIVE lineage(id) AS (
    SELECT $worker_id
    UNION ALL
    SELECT w.parent_worker_id
    FROM workers w
    JOIN lineage l ON w.id = l.id
    WHERE w.parent_worker_id IS NOT NULL
)
SELECT 1 AS member
FROM lineage
WHERE id = $root_worker_id
LIMIT 1;

-- PREP: branch_batch_workspace_open_subscriptions
SELECT COUNT(*) AS n
FROM subscriptions s
JOIN workers w ON w.id = s.worker_id
WHERE w.workspace_id = $workspace_id
  AND s.closed_at IS NULL;
