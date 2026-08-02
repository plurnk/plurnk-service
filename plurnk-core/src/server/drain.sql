-- Drain queries for the worker-level loop queue (SPEC §_run_drain — TBD).
-- Mirrors rummy's AgentLoop drain pattern: enqueue loop at status=100,
-- claim atomically (100 → 102), execute, repeat.

-- PREP: drain_enqueue_loop
-- Insert a loop at queued state. Sequence is per-worker, 1-based.
INSERT INTO loops (worker_id, sequence, status, prompt, provider_spec, max_turns)
VALUES ($worker_id, $sequence, 100, $prompt, $provider_spec, $max_turns)
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
RETURNING id, sequence, prompt, flags, max_turns;

-- PREP: drain_get_loop_max_turns
SELECT max_turns FROM loops WHERE id = $loop_id;

-- PREP: drain_current_loop_for_worker
-- The worker's current NON-TERMINAL loop — active (102) or parked (202). At most one per worker
-- under drain semantics. Engine.inject uses it to write the prompt entry for the right loop's
-- next turn; including 202 lets an irc target a PARKED loop's resume turn (#55) instead of
-- orphaning it with a fresh loop. (102 preferred if both somehow exist.)
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
-- workerId (e.g., a stream concluded in run X; daemon needs the workspace
-- context to write entries under the worker's workspace scope).
SELECT workspace_id FROM workers WHERE id = $worker_id;

-- PREP: drain_count_prompts_for_loop
-- {§prompt-loop-containment} — the per-loop prompt ORDINAL source: N = count+1. The frame key is
-- the Nth prompt of the loop, never a turn slot, so rapid arrivals can never share a row.
SELECT COUNT(*) AS n FROM entries
WHERE scheme = 'prompt' AND owner_id = $owner_id AND pathname LIKE $pattern;

-- PREP: drain_undelivered_prompts_for_loop
-- {§prompt-loop-containment} - the prompts the loop contains but has not yet delivered: no
-- actionless prompt row exists for the frame in this loop. Oldest first; the next turn
-- boundary publishes each, so every arrival reaches the model exactly once.
SELECT c.content, e.pathname
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
WHERE e.scheme = 'prompt'
  AND e.owner_id = $owner_id
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
  AND NOT EXISTS (
      SELECT 1 FROM log_entries le
      WHERE le.loop_id = $loop_id AND le.origin = 'plurnk' AND le.op = 'prompt'
        AND le.scheme = 'prompt' AND le.pathname = e.pathname
  )
ORDER BY e.id ASC;

-- PREP: drain_get_all_prompt_bodies_for_loop
-- Sources the Active User Prompts section: EVERY prompt entry the
-- current loop holds, OLDEST first — typically one, but an active loop admits injected
-- prompts (multiple prompt:///<loop>/<N> entries), all shown in order. Same pattern as
-- the latest-only sibling (promptLoopPrefix pattern, built JS-side); the section renders
-- each body as a bare heredoc.
SELECT c.content, e.pathname
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
WHERE e.scheme = 'prompt'
  AND e.owner_id = $owner_id
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
ORDER BY e.id ASC;

-- PREP: drain_orphaned_prompt_for_loop
-- A loop can terminate before consuming a next-turn prompt injected into it
-- (a wake-on-completion, or a loop.run-while-active that landed on a turn the
-- loop never reached). Engine.inject writes prompt:///<loop>/<N>;
-- if the loop ended at turn K, an injected prompt at turn > K never ran.
-- Returns the latest such orphan's body + the ended loop's flags so
-- the drain can promote it to a fresh loop — no wake silently lost.
-- $pattern = promptLoopPrefix + '%', $prefix_len = length of that prefix
-- built JS-side (per the SqlRite LIKE-binding note above).
SELECT c.content AS body, l.flags AS flags, l.provider_spec AS provider_spec
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
JOIN loops l ON l.id = $loop_id
WHERE e.scheme = 'prompt'
  AND e.owner_id = $owner_id
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
  AND NOT EXISTS (
      SELECT 1 FROM log_entries le
      WHERE le.loop_id = $loop_id AND le.origin = 'plurnk' AND le.op = 'prompt'
        AND le.scheme = 'prompt' AND le.pathname = e.pathname
  )
ORDER BY e.id DESC
LIMIT 1;

-- PREP: drain_find_slept_loop
-- A worker's parked (slept) loop — SEND[202] suspends it at status 202, resumable by a wake
-- ({§worker-lifecycle-wake-liveness}). A worker parks one at a time; take the most recent.
SELECT id FROM loops WHERE worker_id = $worker_id AND status = 202 ORDER BY sequence DESC LIMIT 1;

-- PREP: drain_loop_provider_spec
SELECT provider_spec FROM loops WHERE id = $loop_id;

-- PREP: drain_worker_min_poll
-- grammar 0.74.20 EXEC `<T,P>` — the tightest poll cadence (seconds) among a worker's OPEN
-- subscriptions. open_count distinguishes no stream from an open stream whose cadence is NULL;
-- child-only joins have no polling policy and wake exclusively from child settlement.
SELECT COUNT(*) AS open_count, MIN(poll_seconds) AS poll_seconds
FROM subscriptions WHERE worker_id = $worker_id AND closed_at IS NULL;

-- PREP: worker_parent_id
-- A worker's parent (worker:// spawn / fork set parent_worker_id, {§lifecycle-terms}). NULL = a root run.
-- Used at drain-exit to wake a parent that parked awaiting this child ({§run-lifecycle} topology join).
SELECT parent_worker_id FROM workers WHERE id = $worker_id;
