-- Forensic read queries for bin/digest.ts. Opened via SqlRiteSync against an
-- existing plurnk*.db the daemon already migrated — NO `-- INIT:` blocks, these
-- compile against its schema and never alter it. The digest reads a quiescent
-- DB (a kept test .db or a post-session plurnk.db), so each PREP is its own read
-- — sqlrite 5 dropped the JS transaction composer and these never needed it.

-- PREP: digest_sessions
SELECT * FROM sessions ORDER BY id;

-- PREP: digest_runs
SELECT * FROM runs ORDER BY id;

-- PREP: digest_loops
SELECT id, run_id, sequence, status, prompt, flags
FROM loops ORDER BY run_id, sequence;

-- PREP: digest_turns
SELECT id, loop_id, sequence, status, packet,
       usage_prompt, usage_completion, usage_cached, usage_cost_pico,
       finish_reason, model, timestamp
FROM turns ORDER BY loop_id, sequence;

-- PREP: digest_log_entries
SELECT id, run_id, loop_id, turn_id, sequence, at, origin,
       op, suffix, signal,
       scheme, pathname,
       tx, rx, status_rx, mimetype_rx,
       state, outcome, attrs
FROM log_entries ORDER BY loop_id, turn_id, sequence;

-- PREP: digest_run_rollups
-- Per-run aggregates (token/cost SUMs, loop/turn COUNTs, last-turn status) —
-- the run-summary data-ops, computed in SQL rather than rolled up in JS.
SELECT
    r.id AS run_id,
    COUNT(DISTINCT l.id) AS loops,
    COUNT(t.id) AS turns,
    COALESCE(SUM(t.usage_prompt), 0) AS total_prompt,
    COALESCE(SUM(t.usage_completion), 0) AS total_completion,
    COALESCE(SUM(t.usage_cached), 0) AS total_cached,
    COALESCE(SUM(t.usage_cost_pico), 0) AS total_cost_pico,
    (SELECT t2.status FROM turns t2 JOIN loops l2 ON t2.loop_id = l2.id
     WHERE l2.run_id = r.id ORDER BY l2.sequence DESC, t2.sequence DESC LIMIT 1) AS last_status
FROM runs r
LEFT JOIN loops l ON l.run_id = r.id
LEFT JOIN turns t ON t.loop_id = l.id
GROUP BY r.id
ORDER BY r.id;

-- PREP: digest_run_op_mix
-- Per-run op histogram (GROUP BY run, op), pre-sorted by frequency.
SELECT run_id, op, COUNT(*) AS n
FROM log_entries
GROUP BY run_id, op
ORDER BY run_id, n DESC, op;
