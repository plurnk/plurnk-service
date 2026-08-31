-- {§worker-loop-lifecycle} — the worker-level loop queue: enqueue at status 100,
-- claim atomically (100 → 102) in FIFO order, execute, and continue draining.

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
INSERT INTO loops (worker_id, sequence, status, prompt, prompt_source, model_route_id, spawn_model_route_id, reasoning_policy, max_turns)
VALUES ($worker_id, $sequence, 100, $prompt, $prompt_source, $model_route_id, $spawn_model_route_id, $reasoning_policy, $max_turns)
RETURNING id;

-- PREP: drain_claim_next_loop
-- Atomic claim: flip the oldest queued loop in this worker from 100 → 102 and
-- return it. Returns no row when the queue is empty. The ORDER BY sequence
-- + LIMIT 1 inside the subquery is the FIFO discipline.
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
-- The worker's current NON-TERMINAL loop — active (102) or parked (202). At most one per worker
-- under drain semantics. Engine.inject uses it to write the prompt entry for the right loop's
-- next turn; {§methods-loop-run-fold-consistency} requires an IRC to target a PARKED loop's
-- resume turn instead of orphaning it with a fresh loop. (102 preferred if both somehow exist.)
SELECT id, sequence FROM loops
WHERE worker_id = $worker_id AND status IN (102, 202)
ORDER BY (status = 102) DESC, sequence ASC
LIMIT 1;

-- PREP: drain_next_turn_seq_for_loop
-- Next turn sequence for the given loop. Used by Engine.inject to compute
-- the turn on which its next prompt frame will be published.
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: drain_get_worker_workspace
-- Resolve workerId → workspaceId. Needed when wake/inject paths only have the
-- workerId (e.g., a stream concluded in worker X; daemon needs the workspace
-- context paired with that worker's owner identity).
SELECT workspace_id FROM workers WHERE id = $worker_id;

-- PREP: drain_next_prompt_ordinal_for_loop
-- {§prompt-loop-containment} — derive the next per-loop frame ordinal from the
-- greatest materialized ordinal. The initial frame reserves ordinal 1 even
-- before turn 1 materializes it, so an injection starts at 2.
SELECT COALESCE(MAX(CAST(substr(pathname, $prefix_len + 1) AS INTEGER)), 1) + 1 AS next
FROM entries
WHERE scheme = 'prompt' AND authority = '' AND owner_id = $owner_id AND pathname LIKE $pattern;

-- PREP: drain_undelivered_prompts_for_loop
-- {§prompt-loop-containment} - the prompts the loop contains but has not yet delivered: no
-- actionless prompt row exists for the frame in this loop. Oldest first; the next turn
-- boundary publishes each, so every arrival reaches the model exactly once.
SELECT c.content, e.pathname, e.attributes
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
WHERE e.scheme = 'prompt'
  AND e.authority = ''
  AND e.owner_id = $owner_id
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
  AND NOT EXISTS (
      SELECT 1 FROM log_entries le
      WHERE le.loop_id = $loop_id AND le.origin = '_plurnk' AND le.op = 'prompt'
        AND le.scheme = 'prompt' AND le.pathname = e.pathname
  )
ORDER BY CAST(substr(e.pathname, $prefix_len + 1) AS INTEGER) ASC;

-- PREP: drain_get_all_prompt_bodies_for_loop
-- Sources the Active User Prompts section: EVERY prompt entry the
-- current loop holds, OLDEST first — typically one, but an active loop admits injected
-- prompts (multiple prompt:///<loop>/<N> entries), all shown in order. Same pattern as
-- the latest-only sibling (promptLoopPrefix pattern, built JS-side); the section renders
-- each body in its fixed model-facing enclosure.
SELECT c.content, e.pathname
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
WHERE e.scheme = 'prompt'
  AND e.authority = ''
  AND e.owner_id = $owner_id
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
ORDER BY CAST(substr(e.pathname, $prefix_len + 1) AS INTEGER) ASC;

-- PREP: drain_orphaned_prompts_for_loop
-- A loop can terminate before consuming a next-turn prompt injected into it
-- (a wake-on-completion, or a runLoop-while-active prompt that landed on a turn the
-- loop never reached). Engine.inject writes prompt:///<loop>/<N>;
-- if the loop ended at turn K, an injected prompt at turn > K never ran.
-- Return the complete orphan set oldest-first with the ended loop posture so
-- one recovery loop can preserve frame cardinality and ordering.
-- $pattern = promptLoopPrefix + '%', $prefix_len = length of that prefix
-- built JS-side (per the SqlRite LIKE-binding note above).
SELECT c.content AS body, l.policy AS policy, l.model_route_id AS model_route_id,
       l.spawn_model_route_id AS spawn_model_route_id,
       l.reasoning_policy AS reasoning_policy,
       l.max_turns AS max_turns,
       json_extract(e.attributes, '$.openPaths') AS open_paths,
       json_extract(e.attributes, '$.source') AS prompt_source
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
JOIN loops l ON l.id = $loop_id
WHERE e.scheme = 'prompt'
  AND e.authority = ''
  AND e.owner_id = $owner_id
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
  AND NOT EXISTS (
      SELECT 1 FROM log_entries le
      WHERE le.loop_id = $loop_id AND le.origin = '_plurnk' AND le.op = 'prompt'
        AND le.scheme = 'prompt' AND le.pathname = e.pathname
  )
ORDER BY CAST(substr(e.pathname, $prefix_len + 1) AS INTEGER) ASC;

-- PREP: drain_enqueue_orphan_recovery_loop
-- {§prompt-loop-containment}: recovery identity is the concluded source loop.
-- Retrying returns that same queued loop instead of minting duplicate work.
INSERT INTO loops (
    worker_id, sequence, status, prompt, prompt_source, policy, model_route_id, spawn_model_route_id, reasoning_policy, max_turns,
    open_paths, orphan_source_loop_id
)
VALUES (
    $worker_id, $sequence, 100, $prompt, $prompt_source, $policy, $model_route_id, $spawn_model_route_id, $reasoning_policy, $max_turns,
    $open_paths, $orphan_source_loop_id
)
ON CONFLICT (orphan_source_loop_id) DO UPDATE
SET orphan_source_loop_id = excluded.orphan_source_loop_id
RETURNING id, sequence, status;

-- PREP: drain_rehome_orphaned_prompt_frames
-- Move, rather than copy, the source loop's undelivered entry identities into
-- the recovery loop. The materialized rank freezes the complete source set for
-- this one atomic statement while pathnames change underneath it.
WITH orphaned(id, ordinal) AS MATERIALIZED (
    SELECT e.id,
           ROW_NUMBER() OVER (
               ORDER BY CAST(substr(e.pathname, $source_prefix_len + 1) AS INTEGER) ASC
           )
    FROM entries e
    WHERE e.scheme = 'prompt'
      AND e.authority = ''
      AND e.owner_id = $owner_id
      AND e.pathname LIKE $source_pattern
      AND EXISTS (
          SELECT 1 FROM entry_channels c
          WHERE c.entry_id = e.id AND c.name = 'body'
      )
      AND NOT EXISTS (
          SELECT 1 FROM log_entries le
          WHERE le.loop_id = $source_loop_id AND le.origin = '_plurnk' AND le.op = 'prompt'
            AND le.scheme = 'prompt' AND le.pathname = e.pathname
      )
)
UPDATE entries
SET pathname = $target_prefix || (
    SELECT ordinal FROM orphaned WHERE orphaned.id = entries.id
)
WHERE id IN (SELECT id FROM orphaned)
RETURNING id, pathname;

-- PREP: drain_find_slept_loop
-- A worker's parked (slept) loop — SEND signal 202 suspends it at status 202, resumable by a wake
-- ({§worker-lifecycle-wake-liveness}). A worker parks one at a time; take the most recent.
SELECT id FROM loops WHERE worker_id = $worker_id AND status = 202 ORDER BY sequence DESC LIMIT 1;

-- PREP: drain_loop_generation_policy
SELECT model_route_id, spawn_model_route_id, reasoning_policy FROM loops WHERE id = $loop_id;

-- PREP: drain_worker_min_poll
-- EXEC `<T,P>` — aggregate each open subscription's policy into one worker timer. A fixed cadence
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
-- Used at drain-exit to wake a parent that parked awaiting this child ({§worker-loop-lifecycle} topology join).
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
