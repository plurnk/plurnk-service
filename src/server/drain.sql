-- Drain queries for the run-level loop queue (SPEC §_run_drain — TBD).
-- Mirrors rummy's AgentLoop drain pattern: enqueue loop at status=100,
-- claim atomically (100 → 102), execute, repeat.

-- PREP: drain_enqueue_loop
-- Insert a loop at queued state. Sequence is per-run, 1-based.
INSERT INTO loops (run_id, sequence, status, prompt, persona)
VALUES ($run_id, $sequence, 100, $prompt, $persona)
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
RETURNING id, sequence, prompt, persona, flags;

-- PREP: drain_current_loop_for_run
-- The currently-executing loop for a run (status=102). At most one per run
-- under drain semantics. Engine.inject uses this to write the prompt entry
-- for the right loop's next turn.
SELECT id, sequence FROM loops
WHERE run_id = $run_id AND status = 102
ORDER BY sequence ASC
LIMIT 1;

-- PREP: drain_next_turn_seq_for_loop
-- Next turn sequence for the given loop. Used by Engine.inject to compute
-- the path of the prompt entry it should write (plurnk://prompt/<loop>/<N>).
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: drain_get_run_session
-- Resolve runId → sessionId. Needed when wake/inject paths only have the
-- runId (e.g., a stream concluded in run X; daemon needs the session
-- context to write entries under the run's session scope).
SELECT session_id FROM runs WHERE id = $run_id;

-- PREP: drain_get_latest_prompt_body_for_loop
-- Sources packet.user.prompt at packet-build time. plurnk://prompt/<loop>/<N>
-- entries accumulate per turn; the latest one (highest entries.id) is the
-- "current" prompt the model sees in user.prompt. Falls back to NULL when
-- no prompt entry exists for the loop (caller substitutes runLoop's
-- messages parameter for backward compat with tests that bypass inject).
-- Pattern is built JS-side as `prompt/<loop_id>/%` — SqlRite's parameter
-- binding doesn't reliably coerce integers for `LIKE` with `||`.
SELECT c.content
FROM entries e
JOIN entry_channels c ON c.entry_id = e.id
WHERE e.scheme = 'plurnk'
  AND e.pathname LIKE $pattern
  AND c.name = 'body'
ORDER BY e.id DESC
LIMIT 1;
