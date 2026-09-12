-- TurnRunner: one model turn from packet to admitted emission.

-- PREP: engine_get_loop_prompt
-- Initial prompt frame. Its durable log occurrence, not a process-local/model
-- ordinal, decides whether runTurn still needs to publish it.
WITH initial_prompt AS (
    SELECT e.pathname FROM entries e
    JOIN workers w ON w.workspace_id = e.workspace_id AND w.name = e.authority
    JOIN loops l ON l.worker_id = w.id
    WHERE l.id = $loop_id AND e.scheme = 'prompt'
      AND e.pathname LIKE '/' || l.sequence || '/%'
      AND json_extract(e.attributes, '$.ordinal') = 1
)
SELECT l.prompt, l.prompt_source, l.sequence, l.open_paths,
       (SELECT pathname FROM initial_prompt) AS prompt_pathname,
       EXISTS (
           SELECT 1
           FROM log_entries le
           WHERE le.loop_id = l.id
             AND le.op = 'prompt'
             AND le.pathname = (SELECT pathname FROM initial_prompt)
       ) AS prompt_published
FROM loops l
WHERE l.id = $loop_id;

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_loop_packet_count
-- Exact model-request chronology for client status. Administrative turns and
-- physical provider retries carry no packet and therefore do not contribute.
SELECT id, scheduled_at, repeat_interval_ms, recurrence_root_loop_id,
       (SELECT COUNT(*) FROM turns WHERE loop_id = loops.id AND packet IS NOT NULL) AS count
FROM loops WHERE id = $loop_id;

-- PREP: engine_open_turn_attempt
INSERT INTO turn_attempts (model_call_id)
VALUES ($model_call_id)
RETURNING id;

-- PREP: engine_classify_turn_attempt_response
UPDATE turn_attempts SET
    accepted = $accepted,
    parse_errors = $parse_errors
WHERE id = $id AND accepted IS NULL;

-- PREP: engine_scheme_catalog_summary
-- Per-scheme entry tally plus one-level catalog-row count (direct entries and
-- distinct first-segment `dir/**` summaries). The engine uses the latter to
-- encode a valid first-N file preview range without guessing how many rows the
-- shallow projection will produce.
SELECT e.scheme AS scheme,
    COUNT(DISTINCT e.id) AS entries,
    COUNT(DISTINCT CASE
        WHEN instr(ltrim(e.pathname, '/'), '/') = 0
            THEN json_array('entry', e.authority, ltrim(e.pathname, '/'))
        ELSE json_array('scope', e.authority, substr(ltrim(e.pathname, '/'), 1, instr(ltrim(e.pathname, '/'), '/')))
    END) AS shallow_items
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.workspace_id = $workspace_id
GROUP BY e.scheme
ORDER BY e.scheme;

-- PREP: engine_worker_has_inference_history
-- Administrative turns may legitimately precede the first provider exchange.
-- Initialization is therefore keyed to inference history, never loop ordinals.
SELECT EXISTS (
    SELECT 1
    FROM turns t
    JOIN loops l ON l.id = t.loop_id
    WHERE l.worker_id = $worker_id
      AND (t.producer = 'model' OR t.kind = 'initialization')
) AS present;
