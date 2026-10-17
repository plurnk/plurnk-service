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
ON CONFLICT (coalesce(alias, ''), provider, model, coalesce(base_url, ''))
DO UPDATE SET id = model_routes.id
RETURNING id;

-- PREP: model_route_by_id
SELECT alias, provider, model, base_url FROM model_routes WHERE id = $id;

-- PREP: drain_enqueue_loop
-- Insert a loop at queued state. Sequence is per-worker, 1-based.
INSERT INTO loops (worker_id, sequence, status, prompt, prompt_source, model_route_id, spawn_model_route_id, effort, max_turns)
VALUES ($worker_id, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM loops WHERE worker_id = $worker_id), 100,
        $prompt, $prompt_source, $model_route_id, $spawn_model_route_id, $effort, $max_turns)
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
RETURNING id, sequence, prompt, max_turns;

-- PREP: drain_get_loop_max_turns
SELECT max_turns FROM loops WHERE id = $loop_id;

-- PREP: drain_message_recipient
-- {§loop-addressed-admission} {§loop-wake-identity}
SELECT id, sequence FROM loops
WHERE worker_id = $worker_id
  AND (($loop_id IS NULL AND status IN (102, 202))
    OR (id = $loop_id AND status IN (100, 102, 202)))
ORDER BY (status = 102) DESC, sequence ASC
LIMIT 1;

-- PREP: drain_abandoned_messages
-- {§message-abandonment}: the messages other workers sent that this ended loop still holds without a completion.
SELECT m.path
FROM message_sources m
WHERE m.loop_id = $loop_id
  AND m.source LIKE 'worker://%'
  AND NOT EXISTS (SELECT 1 FROM message_completions c WHERE c.message_id = m.id)
ORDER BY m.ordinal ASC;

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
-- loop's initial message; a later arrival takes the next ordinal. {§worker-obligations}: a worker's own
-- operation names itself as the message's opener, by the row it writes.
INSERT INTO loop_messages (loop_id, ordinal, source, body, open_paths, evidence, address, opened_turn_id, opened_sequence)
SELECT $loop_id, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM loop_messages WHERE loop_id = $loop_id),
       $source, $body, $open_paths, $evidence, $address, $opened_turn_id, $opened_sequence
WHERE EXISTS (SELECT 1 FROM loops WHERE id = $loop_id AND status IN (100, 102, 202))
RETURNING id, ordinal, message_key;
-- PREP: drain_message_path
-- {§worker-obligations}: an admitted message's durable address, the one Open Work names.
SELECT path FROM message_sources WHERE id = $id;

-- PREP: drain_unpublished_messages_for_loop
-- {§message-loop-containment}: the messages the loop contains but has not yet published, oldest
-- first; the next turn boundary publishes each as an inbound SEND row exactly once.
SELECT id, ordinal, source, body, open_paths, key_path AS path, path AS durable_path
FROM message_sources
WHERE loop_id = $loop_id AND log_entry_id IS NULL
ORDER BY ordinal ASC;

-- PREP: drain_has_unpublished_messages
-- {§completion-defers-to-messages}: existence is enough to defer conclusion;
-- publication alone needs the bodies and their ordering.
SELECT 1 AS pending
FROM loop_messages
WHERE loop_id = $loop_id AND log_entry_id IS NULL
LIMIT 1;

-- PREP: drain_publish_message
-- The inbox row's one publication: the inbound SEND row it became.
UPDATE loop_messages SET log_entry_id = $log_entry_id
WHERE id = $id AND log_entry_id IS NULL
RETURNING id;

-- PREP: drain_enqueue_orphan_recovery_loop
-- {§message-loop-containment}: recovery identity is the concluded source loop.
-- The database copies its posture and first unpublished arrival directly; the caller needs only
-- the recovery identity and expected cardinality, never the stored message bodies or policy.
INSERT INTO loops (
    worker_id, sequence, status, prompt, prompt_source, model_route_id, spawn_model_route_id, effort, max_turns,
    orphan_source_loop_id
)
SELECT l.worker_id, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM loops WHERE worker_id = l.worker_id),
       100, m.body, m.source, l.model_route_id, l.spawn_model_route_id, l.effort, l.max_turns, l.id
FROM loops l
JOIN workers w ON w.id = l.worker_id
JOIN loop_messages m ON m.id = (
    SELECT id FROM loop_messages
    WHERE loop_id = l.id AND ordinal > 1 AND log_entry_id IS NULL
    ORDER BY ordinal LIMIT 1
)
WHERE l.id = $orphan_source_loop_id AND l.worker_id = $worker_id
  AND l.status IN (200, 413, 429, 499, 500, 504, 508)
  AND l.terminated_by IS NOT 'cancel'
  AND l.sequence > w.cancelled_through_sequence
ON CONFLICT (orphan_source_loop_id) DO UPDATE
SET orphan_source_loop_id = excluded.orphan_source_loop_id
WHERE loops.status = 100
RETURNING id, sequence, (
    SELECT COUNT(*) FROM loop_messages
    WHERE loop_id = $orphan_source_loop_id AND ordinal > 1 AND log_entry_id IS NULL
) AS message_count;

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
    ordinal = orphaned.ordinal
FROM orphaned
WHERE loop_messages.id = orphaned.id;
-- PREP: drain_find_slept_loop
-- Existence/arrival selection only; completion wakes use all eligible waits.
SELECT id FROM loops WHERE worker_id = $worker_id AND status = 202 ORDER BY sequence ASC LIMIT 1;

-- PREP: drain_loop_generation_policy
SELECT model_route_id, spawn_model_route_id, effort FROM loops WHERE id = $loop_id;

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
