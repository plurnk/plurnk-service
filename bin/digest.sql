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
