-- Drain queries for the run-level loop queue (SPEC §_run_drain — TBD).
-- Mirrors rummy's AgentLoop drain pattern: enqueue loop at status=100,
-- claim atomically (100 → 102), execute, repeat.

-- PREP: drain_enqueue_loop
-- Insert a loop at queued state. Sequence is per-run, 1-based.
INSERT INTO loops (run_id, sequence, status, prompt)
VALUES ($run_id, $sequence, 100, $prompt)
RETURNING id;

-- PREP: drain_claim_next_loop
-- Atomic claim: flip the oldest queued loop in this run from 100 → 102 and
-- return it. Returns no row when the queue is empty. The ORDER BY sequence
-- + LIMIT 1 inside the subquery is the FIFO discipline.
UPDATE loops
SET status = 102
WHERE id = (
    SELECT id FROM loops
    WHERE run_id = $run_id AND status = 100
    ORDER BY sequence ASC
    LIMIT 1
)
RETURNING id, sequence, prompt, flags;

-- PREP: drain_current_loop_for_run
-- The run's current NON-TERMINAL loop — active (102) or parked (202). At most one per run
-- under drain semantics. Engine.inject uses it to write the prompt entry for the right loop's
-- next turn; including 202 lets an irc target a PARKED loop's resume turn (#55) instead of
-- orphaning it with a fresh loop. (102 preferred if both somehow exist.)
SELECT id, sequence FROM loops
WHERE run_id = $run_id AND status IN (102, 202)
ORDER BY (status = 102) DESC, sequence ASC
LIMIT 1;

-- PREP: drain_next_turn_seq_for_loop
-- Next turn sequence for the given loop. Used by Engine.inject to compute
-- the path of the prompt entry it should write (plurnk://prompt/<run>/<loop>/<N>).
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: drain_get_run_session
-- Resolve runId → sessionId. Needed when wake/inject paths only have the
-- runId (e.g., a stream concluded in run X; daemon needs the session
-- context to write entries under the run's session scope).
SELECT session_id FROM runs WHERE id = $run_id;

-- PREP: drain_get_latest_prompt_body_for_loop
-- Sources packet.user.prompt at packet-build time. plurnk://prompt/<run>/<loop>/<N>
-- entries accumulate per turn; the latest one (highest entries.id) is the
-- "current" prompt the model sees in user.prompt. Falls back to NULL when
-- no prompt entry exists for the loop (caller substitutes runLoop's
-- messages parameter for backward compat with tests that bypass inject).
-- Pattern is built JS-side via promptLoopPrefix (run-qualified `/prompt/<run>/<loop>/%`,
-- matching the foist's #pathnameOf and the inject) — SqlRite's parameter
-- binding doesn't reliably coerce integers for `LIKE` with `||`.
SELECT c.content, e.pathname
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
WHERE e.scheme = 'plurnk'
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
ORDER BY e.id DESC
LIMIT 1;

-- PREP: drain_get_all_prompt_bodies_for_loop
-- Sources the Active User Prompts section (§prompt-fold): EVERY prompt entry the
-- current loop holds, OLDEST first — typically one, but an active loop admits injected
-- prompts (multiple plurnk://prompt/<run>/<loop>/<N>), all shown in order. Same pattern as
-- the latest-only sibling (promptLoopPrefix pattern, built JS-side); the section renders
-- each body as a bare heredoc.
SELECT c.content, e.pathname
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
WHERE e.scheme = 'plurnk'
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
ORDER BY e.id ASC;

-- PREP: drain_orphaned_prompt_for_loop
-- A loop can terminate before consuming a next-turn prompt injected into it
-- (a wake-on-completion, or a loop.run-while-active that landed on a turn the
-- loop never reached). Engine.inject writes prompt/<run>/<loop>/<N> at MAX(turn)+1;
-- if the loop ended at turn K, an injected prompt at turn > K never ran.
-- Returns the latest such orphan's body + the ended loop's flags so
-- the drain can promote it to a fresh loop — no wake silently lost.
-- $pattern = promptLoopPrefix + '%', $prefix_len = length of that prefix
-- built JS-side (per the SqlRite LIKE-binding note above).
SELECT c.content AS body, l.flags AS flags
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
JOIN loops l ON l.id = $loop_id
WHERE e.scheme = 'plurnk'
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
  AND CAST(substr(e.pathname, $prefix_len + 1) AS INTEGER) >
      (SELECT COALESCE(MAX(sequence), 0) FROM turns WHERE loop_id = $loop_id)
ORDER BY e.id DESC
LIMIT 1;

-- PREP: drain_find_slept_loop
-- A run's parked (slept) loop — SEND[202] suspends it at status 202, resumable by a wake
-- (§run-lifecycle-wake-liveness). A run parks one at a time; take the most recent.
SELECT id FROM loops WHERE run_id = $run_id AND status = 202 ORDER BY sequence DESC LIMIT 1;

-- PREP: drain_resume_slept_loop
-- Re-queue a slept (202) loop to status 100 so the drain re-claims and CONTINUES it. The
-- engine's next-turn-sequence is DB-derived, so the resumed loop foists no prompt (seq > 1).
UPDATE loops SET status = 100 WHERE id = $loop_id AND status = 202;

-- PREP: drain_run_min_poll
-- grammar 0.74.20 EXEC `<T,P>` — the tightest poll cadence (seconds) among a run's OPEN
-- polled subscriptions. NULL when the run holds no polled stream → no hibernation poll-wake.
SELECT MIN(poll_seconds) AS poll_seconds
FROM subscriptions WHERE run_id = $run_id AND closed_at IS NULL AND poll_seconds IS NOT NULL;

-- PREP: run_parent_id
-- A run's parent (run:// spawn / fork set parent_run_id, §lifecycle-terms). NULL = a root run.
-- Used at drain-exit to wake a parent that parked awaiting this child (§run-lifecycle topology join).
SELECT parent_run_id FROM runs WHERE id = $run_id;

-- PREP: drain_active_loop_flags
-- #368 — the LIVE loop's persisted flags for the fold-posture guard: an inject carrying flags
-- that differ from the loop it would fold into is refused, never a silent posture discard.
-- The run's currently-executing loop is its most recent non-terminal one.
SELECT id, flags FROM loops WHERE run_id = $run_id AND status IN (100, 102) ORDER BY sequence DESC LIMIT 1;
