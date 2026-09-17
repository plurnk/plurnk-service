-- {§worker-loop-lifecycle} — the worker-level loop queue: enqueue at status 100,
-- claim eligible tasks atomically (100 → 102) in FIFO order and continue draining.

-- {§worker-model-selection} — resolved model routes are append-only; one row per complete
-- resolved tuple. Create-or-lookup is one owner (the drain boundary).
-- PREP: model_route_lookup
SELECT id FROM model_routes
WHERE alias IS $alias AND provider = $provider AND model = $model AND base_url IS $base_url;

-- PREP: model_route_create
INSERT INTO model_routes (alias, provider, model, base_url)
VALUES ($alias, $provider, $model, $base_url)
RETURNING id;

-- PREP: model_route_by_id
SELECT alias, provider, model, base_url FROM model_routes WHERE id = $id;

-- PREP: drain_enqueue_loop
-- Insert a loop at queued state. Sequence is per-worker, 1-based.
INSERT INTO loops (worker_id, sequence, status, prompt, prompt_source, model_route_id, spawn_model_route_id, reasoning_policy, max_turns, policy)
VALUES ($worker_id, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM loops WHERE worker_id = $worker_id), 100,
        $prompt, $prompt_source, $model_route_id, $spawn_model_route_id, $reasoning_policy, $max_turns, $policy)
RETURNING id;

-- PREP: drain_ready_loop
SELECT id FROM loops WHERE worker_id = $worker_id AND status = 100
ORDER BY sequence LIMIT 1;

-- PREP: drain_claim_next_loop
-- Claim the oldest queued loop.
UPDATE loops
SET status = 102
WHERE id = (
    SELECT id FROM loops
    WHERE worker_id = $worker_id AND status = 100
    ORDER BY sequence ASC
    LIMIT 1
)
RETURNING id, sequence, prompt, policy, max_turns;

-- PREP: drain_get_loop_max_turns
SELECT max_turns FROM loops WHERE id = $loop_id;

-- PREP: drain_current_loop_for_worker
-- {§loop-wake-identity}: unaddressed arrivals choose the running loop first,
-- otherwise the oldest parked loop. Admission checks and writes that exact id.
SELECT id, sequence FROM loops
WHERE worker_id = $worker_id AND status IN (102, 202)
ORDER BY (status = 102) DESC, sequence ASC
LIMIT 1;

-- PREP: drain_injection_target
SELECT worker_id, sequence FROM loops WHERE id = $loop_id AND status IN (100, 102, 202);

-- PREP: drain_message_source
SELECT l.worker_id, w.workspace_id, l.status
FROM loops l JOIN workers w ON w.id = l.worker_id
WHERE l.id = $loop_id;

-- PREP: drain_next_turn_seq_for_loop
-- Next turn sequence for the given loop. Used by Engine.inject to compute
-- the turn on which its next message will be published.
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: drain_get_worker_workspace
-- Resolve workerId → workspaceId. Needed when wake/inject paths only have the
-- workerId (e.g., a stream concluded in worker X; daemon needs the workspace
-- context paired with that worker's owner identity).
SELECT workspace_id FROM workers WHERE id = $worker_id;

-- PREP: drain_enqueue_message
-- {§message-arrival}: append one message to the loop's inbox in arrival order. Ordinal 1 is the
-- loop's initial message; a later arrival takes the next ordinal.
INSERT INTO loop_messages (loop_id, ordinal, source, body, open_paths, evidence, address)
VALUES ($loop_id, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM loop_messages WHERE loop_id = $loop_id),
        $source, $body, $open_paths, $evidence, $address)
RETURNING id, ordinal;
-- PREP: drain_unpublished_messages_for_loop
-- {§message-loop-containment}: the messages the loop contains but has not yet published, oldest
-- first; the next turn boundary publishes each as an inbound SEND row exactly once.
SELECT id, ordinal, source, body, open_paths, path
FROM message_sources
WHERE loop_id = $loop_id AND log_entry_id IS NULL
ORDER BY ordinal ASC;

-- PREP: drain_unpublished_arrivals_for_loop
-- {§completion-defers-to-messages}: the messages that arrived after the loop began and are not
-- yet published. Ordinal 1 is the loop's assignment, published by the first turn boundary before
-- any model disposition can exist, so it never defers a completion.
SELECT id, ordinal
FROM loop_messages
WHERE loop_id = $loop_id AND ordinal > 1 AND log_entry_id IS NULL
ORDER BY ordinal ASC;

-- PREP: drain_publish_message
-- The inbox row's one publication: the inbound SEND row it became.
UPDATE loop_messages SET log_entry_id = $log_entry_id
WHERE id = $id AND log_entry_id IS NULL
RETURNING id;

-- PREP: drain_orphaned_messages_for_loop
-- A loop can conclude before publishing a message injected into it (a wake-on-completion, or a
-- runLoop-while-active arrival that landed on a turn the loop never reached). Return the complete
-- unpublished set oldest-first with the ended loop's posture so one recovery loop preserves
-- cardinality and order ({§message-loop-containment}). Ordinal 1 is the loop's own assignment:
-- its fate is the loop's, never replayed into fresh work.
SELECT m.body AS body, m.source AS source, m.open_paths AS open_paths,
       l.policy AS policy, l.model_route_id AS model_route_id,
       l.spawn_model_route_id AS spawn_model_route_id,
       l.reasoning_policy AS reasoning_policy,
       l.max_turns AS max_turns
FROM loop_messages m
JOIN loops l ON l.id = m.loop_id
WHERE m.loop_id = $loop_id
  AND m.ordinal > 1
  AND m.log_entry_id IS NULL
  AND l.status IN (200, 413, 429, 499, 500, 504, 508)
  AND l.terminated_by IS NOT 'cancel'
  AND l.sequence > (SELECT cancelled_through_sequence FROM workers WHERE id = l.worker_id)
ORDER BY m.ordinal ASC;
-- PREP: drain_enqueue_orphan_recovery_loop
-- {§message-loop-containment}: recovery identity is the concluded source loop.
-- Retrying returns that same queued loop instead of minting duplicate work.
INSERT INTO loops (
    worker_id, sequence, status, prompt, prompt_source, policy, model_route_id, spawn_model_route_id, reasoning_policy, max_turns,
    orphan_source_loop_id
)
VALUES (
    $worker_id, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM loops WHERE worker_id = $worker_id),
    100, $prompt, $prompt_source, $policy, $model_route_id, $spawn_model_route_id, $reasoning_policy, $max_turns,
    $orphan_source_loop_id
)
ON CONFLICT (orphan_source_loop_id) DO UPDATE
SET orphan_source_loop_id = excluded.orphan_source_loop_id
RETURNING id, sequence, status;

-- PREP: drain_rehome_orphaned_messages
-- Move, rather than copy, the source loop's unpublished messages into the recovery loop,
-- renumbered from 1 so the first becomes the recovery loop's headline. The materialized rank
-- freezes the complete source set for this one atomic statement.
WITH orphaned(id, ordinal) AS MATERIALIZED (
    SELECT id, ROW_NUMBER() OVER (ORDER BY ordinal ASC)
    FROM loop_messages
    WHERE loop_id = $source_loop_id AND ordinal > 1 AND log_entry_id IS NULL
)
UPDATE loop_messages
SET loop_id = $target_loop_id,
    ordinal = (SELECT ordinal FROM orphaned WHERE orphaned.id = loop_messages.id)
WHERE id IN (SELECT id FROM orphaned)
RETURNING id, ordinal;
-- PREP: drain_find_slept_loop
-- Existence/arrival selection only; completion wakes use all eligible waits.
SELECT id FROM loops WHERE worker_id = $worker_id AND status = 202 ORDER BY sequence ASC LIMIT 1;

-- PREP: drain_loop_generation_policy
SELECT model_route_id, spawn_model_route_id, reasoning_policy FROM loops WHERE id = $loop_id;

-- PREP: drain_worker_min_poll
-- Execution `<T,P>` — aggregate each open subscription's policy into one worker timer. A fixed cadence
-- wins at its tightest positive value; otherwise any omitted cadence requests default backoff;
-- only an all-zero set disables the timer. Child-only joins have no subscription policy.
SELECT
    COUNT(*) AS open_count,
    CASE
        WHEN COUNT(*) = 0 THEN NULL
        WHEN MIN(CASE WHEN poll_seconds > 0 THEN poll_seconds END) IS NOT NULL
            THEN MIN(CASE WHEN poll_seconds > 0 THEN poll_seconds END)
        WHEN SUM(CASE WHEN poll_seconds IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
        ELSE 0
    END AS poll_seconds
FROM subscriptions WHERE worker_id = $worker_id AND closed_at IS NULL;

-- PREP: worker_parent_id
-- A worker's parent (worker:// spawn / fork set parent_worker_id, {§lifecycle-terms}). NULL = a root worker.
-- {§worker-lifecycle-child-wake}: direct parent of a terminal task's worker.
SELECT parent_worker_id FROM workers WHERE id = $worker_id;

-- PREP: worker_lineage_contains
-- Whether $root_worker_id is $worker_id or one of its ancestors — the workspace
-- gate's lineage test for exclusive holders.
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
