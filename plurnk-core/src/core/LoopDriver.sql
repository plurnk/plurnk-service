-- LoopDriver: the loop's status as the drive loop reads and reclaims it.

-- PREP: engine_loop_status
SELECT status, wait_revision FROM loops WHERE id = $loop_id;

-- PREP: engine_reclaim_queued_loop
-- {§worker-lifecycle-wake-requeue-not-terminal} — atomic 100→102 re-claim by loop id. A wake
-- re-queued this loop while ITS OWN live drain was between turns; the drain re-claims and
-- keeps running (the injected prompt is already the next turn). Conditional so a racing
-- claimant can never double-claim.
UPDATE loops SET status = 102 WHERE id = $loop_id AND status = 100;
