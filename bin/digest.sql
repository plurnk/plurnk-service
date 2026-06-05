-- Forensic read queries for bin/digest.ts. Opened via SqlRiteSync against an
-- existing plurnk*.db the daemon already migrated — NO `-- INIT:` blocks, these
-- compile against its schema and never alter it. Snapshot consistency is the
-- caller's `db.transaction([...])` (BEGIN/COMMIT around the whole set, deferred
-- by default in SQLite), so a live daemon committing mid-read can't skew counts.

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

-- PREP: digest_turns_count
SELECT COUNT(*) AS n FROM turns;

-- PREP: digest_logs_count
SELECT COUNT(*) AS n FROM log_entries;
