-- Forensic read queries for bin/digest.ts. Opened via SqlRiteSync against an
-- existing plurnk*.db initialized from the schema baseline — NO `-- INIT:` blocks, these
-- compile against its schema and never alter it. The digest reads a quiescent
-- DB (a kept test .db or a post-workspace plurnk.db), so each PREP is its own read
-- — sqlrite 5 dropped the JS transaction composer and these never needed it.

-- PREP: digest_schema_tables
SELECT name FROM sqlite_schema WHERE type = 'table';

-- PREP: digest_schema_columns
SELECT name FROM pragma_table_info($table) ORDER BY cid;

-- PREP: digest_workspaces
SELECT * FROM workspaces ORDER BY id;

-- PREP: digest_workers
SELECT * FROM workers ORDER BY id;

-- PREP: digest_loops
SELECT id, worker_id, sequence, status, prompt, policy, terminated_by, terminal_result
FROM loops ORDER BY worker_id, sequence;

-- PREP: digest_turns
SELECT id, loop_id, sequence, producer, kind, status, completed_at, packet,
       finish_reason, model, meta, timestamp
FROM turns ORDER BY loop_id, sequence;

-- PREP: digest_turn_attempts
SELECT a.id, mc.id AS model_call_id, ic.turn_id, ic.sequence, ic.kind,
       ic.state, a.accepted, mc.response, mc.failure,
       a.parse_errors, ic.attributions,
       mc.finish_reason, COALESCE(mc.response_model, ic.request_model) AS model,
       ic.request_model, mc.response_model, ic.timestamp, ic.completed_at
FROM turn_attempts a
JOIN model_calls mc ON mc.id = a.model_call_id
JOIN inference_calls ic ON ic.id = mc.id
ORDER BY ic.turn_id, ic.sequence;

-- PREP: digest_inference_calls
SELECT id, workspace_id, turn_id, sequence, kind, state, attributions,
       request_model, timestamp, completed_at
FROM inference_calls
ORDER BY workspace_id, timestamp, id;

-- PREP: digest_model_calls
SELECT mc.id, ic.workspace_id, ic.turn_id, ic.sequence, ic.kind, ic.state,
       mc.response, mc.failure, mc.capacity, ic.attributions,
       mc.finish_reason, COALESCE(mc.response_model, ic.request_model) AS model,
       ic.request_model, mc.response_model, ic.timestamp, ic.completed_at,
       a.id AS turn_attempt_id, a.accepted, a.parse_errors,
       le.id AS log_entry_id
FROM model_calls mc
JOIN inference_calls ic ON ic.id = mc.id
LEFT JOIN turn_attempts a ON a.model_call_id = mc.id
LEFT JOIN log_entries le ON le.model_call_id = mc.id
ORDER BY ic.workspace_id, ic.timestamp, ic.id;

-- PREP: digest_embedding_calls
SELECT ec.id, ic.workspace_id, ic.turn_id, ic.sequence, ic.kind, ic.state,
       ic.request_model AS model, ec.input_count, ec.output_count,
       ec.metadata, ec.failure, ic.timestamp, ic.completed_at
FROM embedding_calls ec
JOIN inference_calls ic ON ic.id = ec.id
ORDER BY ic.workspace_id, ic.timestamp, ic.id;

-- PREP: digest_provider_requests
-- Cardinal physical-request ledger with ownership coordinates for derived
-- workspace/worker/loop/turn projections.
SELECT pr.id, pr.inference_call_id, a.id AS turn_attempt_id, ic.kind,
       ic.turn_id, t.loop_id, l.worker_id, ic.workspace_id,
       pr.sequence, pr.provider, pr.model, pr.state, pr.outcome, pr.status,
       pr.usage_input, pr.usage_output, pr.usage_total,
       pr.usage_input_no_cache, pr.usage_input_cache_read, pr.usage_input_cache_write,
       pr.usage_output_text, pr.usage_output_reasoning,
       pr.cost_kind, pr.cost_amount, pr.cost_currency, pr.cost_usd_equivalent,
       pr.cost_source, pr.cost_reason, pr.started_at, pr.completed_at
FROM provider_requests pr
JOIN inference_calls ic ON ic.id = pr.inference_call_id
LEFT JOIN turn_attempts a ON a.model_call_id = ic.id
LEFT JOIN turns t ON t.id = ic.turn_id
LEFT JOIN loops l ON l.id = t.loop_id
LEFT JOIN workers w ON w.id = l.worker_id
ORDER BY ic.workspace_id, ic.timestamp, ic.id, pr.sequence;

-- PREP: digest_log_entries
SELECT id, worker_id, loop_id, turn_id, sequence, at, origin, source, model_call_id,
       op, delimiter, signal,
       scheme, hostname, port, pathname, query, fragment,
       rx, status_rx, mimetype_rx,
       state, outcome, attrs, initial_folded,
       projection.active AS projection_active,
       projection.folded AS projection_folded,
       COALESCE((
           SELECT json_group_array(ordered.tag)
           FROM (
               SELECT tag FROM log_tags WHERE log_entry_id = le.id ORDER BY tag
           ) ordered
       ), '[]') AS tags
FROM log_entries le
JOIN log_entry_projections projection ON projection.log_entry_id = le.id
ORDER BY loop_id, turn_id, sequence;

-- PREP: digest_worker_rollups
-- Structural per-worker aggregates. Accounting is derived through the shared
-- exact-decimal provider contract rather than SQLite numeric arithmetic.
SELECT
    r.id AS worker_id,
    COUNT(DISTINCT l.id) AS loops,
    COUNT(t.id) AS turns,
    (SELECT t2.status FROM turns t2 JOIN loops l2 ON t2.loop_id = l2.id
     WHERE l2.worker_id = r.id ORDER BY t2.id DESC LIMIT 1) AS last_status
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
