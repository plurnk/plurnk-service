-- LoopPolicyReader: the loop's immutable policy.

-- PREP: engine_get_loop_policy
-- Complete persisted policy. LoopPolicyReader is the sole validation path
-- ({§loop-policy-effective-read}).
SELECT policy FROM loops WHERE id = $loop_id;
