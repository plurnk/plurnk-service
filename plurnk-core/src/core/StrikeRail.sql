-- {§loop-rail-continuity}: StrikeRail owns private per-loop assessment state.

-- PREP: strike_rail_state
SELECT strike_streak, cycle_history, cycle_wait_revision
FROM loops WHERE id = $loop_id;

-- PREP: strike_rail_assess
UPDATE loops
SET strike_streak = $streak,
    cycle_history = $history,
    cycle_wait_revision = $wait_revision
WHERE id = $loop_id;
