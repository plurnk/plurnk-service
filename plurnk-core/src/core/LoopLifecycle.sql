-- Durable loop lifecycle transitions. LoopLifecycle is the only TypeScript owner
-- of the transitions; callers request them rather than writing status. The loop's
-- identity read (engine_loop_sequence) is shared by every coordinate renderer.

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
    wait_poll_at = NULL
WHERE id = $loop_id AND status = 102
RETURNING id;

-- PREP: lifecycle_wake_loop
UPDATE loops
SET status = 100,
    wait_poll_at = NULL
WHERE id = $loop_id AND status = 202
  AND ($revision IS NULL OR wait_revision = $revision)
  AND ($due_at IS NULL OR wait_poll_at <= $due_at)
  AND ($event_only = 0 OR observed_wake_revision < (SELECT wake_revision FROM workers WHERE id = loops.worker_id))
RETURNING id;

-- PREP: lifecycle_parked_loops
SELECT id, wait_revision, wait_poll_at
FROM loops WHERE worker_id = $worker_id AND status = 202
ORDER BY sequence;

-- PREP: lifecycle_set_inherited_poll
UPDATE loops SET wait_poll_at = $poll_at
WHERE id = $loop_id AND status = 202 AND wait_revision = $revision
  AND wait_poll_at IS NULL;

-- PREP: lifecycle_finish_loop
UPDATE loops
SET status = $status,
    execution_elapsed_ms = COALESCE($elapsed_ms, execution_elapsed_ms),
    wait_poll_at = NULL,
    terminal_result = $result,
    terminated_by = $terminated_by
WHERE id = $loop_id AND status IN (100, 102, 202)
  AND ($require_answered = 0 OR NOT EXISTS (SELECT 1 FROM unanswered_messages WHERE loop_id = loops.id))
  AND ($require_answered = 0 OR observed_wake_revision = (SELECT wake_revision FROM workers WHERE id = loops.worker_id))
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

-- PREP: lifecycle_checkpoint_executions
-- Consumption measured by the process-local monotonic timers ({§loop-execution-allowance}) lands
-- before the cutoff, so the cancellation trigger finds every live loop's charge already durable.
UPDATE loops
SET execution_elapsed_ms = (
    SELECT json_extract(value, '$.elapsed_ms') FROM json_each($executions)
    WHERE json_extract(value, '$.loop_id') = loops.id
)
WHERE id IN (SELECT json_extract(value, '$.loop_id') FROM json_each($executions));

-- PREP: lifecycle_cancel_workers
-- {§worker-causal-admission}: the cutoff and the cancellation are one durable decision — this
-- statement writes both onto the worker, and workers_cancel_live_loops retires the loops inside it.
UPDATE workers
SET cancelled_through_sequence = MAX(cancelled_through_sequence, COALESCE(
        (SELECT MAX(sequence) FROM loops WHERE worker_id = workers.id), 0
    )),
    cancellation = $result
WHERE id IN (SELECT value FROM json_each($worker_ids));

-- PREP: lifecycle_cancelled_loops
SELECT loops.id AS loop_id, loops.worker_id, loops.terminal_result FROM loops
JOIN json_each($worker_cutoffs) cutoff ON loops.worker_id = json_extract(cutoff.value, '$.worker_id')
WHERE loops.sequence > json_extract(cutoff.value, '$.cancelled_through_sequence')
  AND loops.status = 499 AND loops.terminated_by = 'cancel'
ORDER BY loops.id;

-- INIT: loops_stamp_claimed_at_insert
-- {§loop-claim-latency}: a loop inserted running is claimed at its insertion; the first claim stays.
DROP TRIGGER IF EXISTS loops_stamp_claimed_at_insert;
CREATE TRIGGER loops_stamp_claimed_at_insert
AFTER INSERT ON loops
WHEN NEW.status = 102 AND NEW.claimed_at IS NULL
BEGIN
    UPDATE loops SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- INIT: loops_stamp_claimed_at_update
-- {§loop-claim-latency}: a queued loop is claimed when it first moves to 102.
DROP TRIGGER IF EXISTS loops_stamp_claimed_at_update;
CREATE TRIGGER loops_stamp_claimed_at_update
AFTER UPDATE OF status ON loops
WHEN NEW.status = 102 AND OLD.status <> 102 AND NEW.claimed_at IS NULL
BEGIN
    UPDATE loops SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- INIT: loops_stamp_terminated_at
-- {§worker-scheme}: a loop crossing into a terminal status stamps terminated_at, so sibling
-- workers observe the terminal outcome uniformly across every conclusion path.
-- The stamp updates terminated_at,
-- never status, so it cannot re-fire this trigger. Terminals: 200 done · 413 budget ·
-- 429 turn-ceiling · 499 cancel · 500 fail · 504 execution timeout · 508 runaway. (202 = parked/sleeping, NOT terminal.)
DROP TRIGGER IF EXISTS loops_stamp_terminated_at;
CREATE TRIGGER loops_stamp_terminated_at
AFTER UPDATE OF status ON loops
WHEN NEW.status IN (200, 413, 429, 499, 500, 504, 508) AND OLD.status NOT IN (200, 413, 429, 499, 500, 504, 508)
BEGIN
    UPDATE loops SET terminated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- INIT: workers_cancel_live_loops
-- {§worker-cancel-trigger}: writing a worker's cancellation retires its live loops in the same
-- statement — 499, waits cleared, the
-- Problem instanced per loop. Loops already terminal keep their own outcome.
DROP TRIGGER IF EXISTS workers_cancel_live_loops;
CREATE TRIGGER workers_cancel_live_loops
AFTER UPDATE OF cancellation ON workers
WHEN NEW.cancellation IS NOT NULL
BEGIN
    UPDATE loops
    SET status = 499,
        wait_poll_at = NULL,
        terminal_result = json_set(
            NEW.cancellation,
            '$.problem.instance',
            'ops://' || NEW.name || '/' || sequence
        ),
        terminated_by = 'cancel'
    WHERE worker_id = NEW.id
      AND status IN (100, 102, 202);
END;

-- PREP: engine_loop_sequence
SELECT sequence FROM loops WHERE id = $loop_id;

-- PREP: loop_resource_identity
SELECT 'ops://' || w.name || '/' || l.sequence AS resource
FROM loops l JOIN workers w ON w.id = l.worker_id WHERE l.id = $loop_id;

-- PREP: loop_live_obligations
-- {§worker-obligations}: the live work a loop is held on — its worker's open streams and live children.
SELECT streams, workers FROM loop_obligations WHERE loop_id = $loop_id;

-- PREP: lifecycle_tree_budget
-- {§turn-cap-counts-the-tree} — the budget of the worker tree a loop belongs to. The owner is
-- the current loop (id at or below this loop's) of the topmost ancestor-or-self worker that has
-- one: for a tree a client started, the root worker's loop current when this loop began; a loop
-- with no such ancestor owns its own budget. Every model call on the owner's loop and on any
-- later loop of the owner's descendants spends it, emission and BARE alike, open or settled, one
-- per call however many physical requests it took.
WITH RECURSIVE up(id, parent_worker_id, depth) AS (
    SELECT w.id, w.parent_worker_id, 0 FROM workers w
    WHERE w.id = (SELECT worker_id FROM loops WHERE id = $loop_id)
    UNION ALL
    SELECT w.id, w.parent_worker_id, up.depth + 1 FROM workers w JOIN up ON w.id = up.parent_worker_id
),
owner AS (
    SELECT l.id AS loop_id, l.max_turns, up.id AS worker_id FROM up
    JOIN loops l ON l.worker_id = up.id
    WHERE l.id <= $loop_id
    ORDER BY up.depth DESC, l.id DESC LIMIT 1
),
tree(id) AS (
    SELECT worker_id FROM owner
    UNION ALL
    SELECT w.id FROM workers w JOIN tree ON w.parent_worker_id = tree.id
)
SELECT
    (SELECT loop_id FROM owner) AS root_loop_id,
    (SELECT max_turns FROM owner) AS max_turns,
    (SELECT COUNT(*) FROM inference_calls ic
        JOIN turns t ON t.id = ic.turn_id
        JOIN loops l ON l.id = t.loop_id
        WHERE l.id = (SELECT loop_id FROM owner)
           OR (l.worker_id IN (SELECT id FROM tree)
               AND l.worker_id != (SELECT worker_id FROM owner)
               AND l.id > (SELECT loop_id FROM owner))
    ) AS count;
