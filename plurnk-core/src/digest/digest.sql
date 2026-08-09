-- Forensic read queries for bin/digest.ts. Opened via SqlRiteSync against an
-- existing plurnk*.db initialized from the schema baseline — NO `-- INIT:` blocks, these
-- compile against its schema and never alter it. The digest reads a quiescent
-- DB (a kept test .db or a post-workspace plurnk.db), so each PREP is its own read
-- — sqlrite 5 dropped the JS transaction composer and these never needed it.

-- PREP: digest_workspaces
SELECT * FROM workspaces ORDER BY id;

-- PREP: digest_workers
SELECT * FROM workers ORDER BY id;

-- PREP: digest_loops
SELECT id, worker_id, sequence, status, prompt, flags, terminated_by, terminal_result,
       accounting_scope_id, accounting_state, accounting_charge, accounting_cost_usd,
       accounting_detail, accounting_evaluated_at
FROM loops ORDER BY worker_id, sequence;

-- PREP: digest_turns
SELECT id, loop_id, sequence, status, packet,
       usage_prompt, usage_completion, usage_reasoning, usage_cached, usage_cost, usage_cost_usd,
       finish_reason, model, meta, timestamp
FROM turns ORDER BY loop_id, sequence;

-- PREP: digest_turn_attempts
SELECT id, turn_id, sequence, accounting_id, state, accepted, response, failure,
       parse_errors, attributions,
       usage_prompt, usage_completion, usage_reasoning, usage_cached, usage_cost, usage_cost_usd,
       finish_reason, model, timestamp, completed_at
FROM turn_attempts
ORDER BY turn_id, sequence;

-- PREP: digest_log_entries
SELECT id, worker_id, loop_id, turn_id, sequence, at, origin, source,
       op, suffix, signal,
       scheme, hostname, port, pathname, query, fragment,
       rx, status_rx, mimetype_rx,
       state, outcome, attrs
FROM log_entries ORDER BY loop_id, turn_id, sequence;

-- PREP: digest_worker_rollups
-- Per-worker aggregates (token/cost SUMs, loop/turn COUNTs, last-turn status) —
-- the worker-summary data, computed in SQL rather than rolled up in JS.
SELECT
    r.id AS worker_id,
    COUNT(DISTINCT l.id) AS loops,
    COUNT(t.id) AS turns,
    COALESCE(SUM(t.usage_prompt), 0) AS total_prompt,
    COALESCE(SUM(t.usage_completion), 0) AS total_completion,
    COALESCE(SUM(t.usage_reasoning), 0) AS total_reasoning,
    COALESCE(SUM(t.usage_cached), 0) AS total_cached,
    (SELECT CASE WHEN COUNT(*) FILTER (WHERE lc.cost_usd IS NULL) > 0
                 THEN NULL ELSE COALESCE(SUM(lc.cost_usd), 0) END
       FROM loop_costs lc
      WHERE lc.worker_id = r.id) AS total_cost_usd,
    (SELECT t2.status FROM turns t2 JOIN loops l2 ON t2.loop_id = l2.id
     WHERE l2.worker_id = r.id ORDER BY l2.sequence DESC, t2.sequence DESC LIMIT 1) AS last_status
FROM workers r
LEFT JOIN loops l ON l.worker_id = r.id
LEFT JOIN turns t ON t.loop_id = l.id
GROUP BY r.id
ORDER BY r.id;

-- PREP: digest_worker_op_mix
-- Per-worker op histogram (GROUP BY worker, op), pre-sorted by frequency.
SELECT worker_id, op, COUNT(*) AS n
FROM log_entries
WHERE op IS NOT NULL
GROUP BY worker_id, op
ORDER BY worker_id, n DESC, op;
