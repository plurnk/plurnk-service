-- TurnRunner: one model turn from packet to admitted emission.

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_loop_packet_count
-- {§notifications} The loop's number and its exact model-request chronology for client status.
-- Administrative turns and physical provider retries carry no packet and therefore do not contribute.
SELECT id, sequence,
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
-- encode a valid first-N catalog survey range ({§session-initialization-entry}) without
-- guessing how many rows the shallow projection will produce.
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

-- PREP: engine_session_has_inference_history
-- Administrative turns may legitimately precede the first provider exchange.
-- Initialization is therefore keyed to inference history, never loop ordinals.
SELECT EXISTS (
    SELECT 1
    FROM turns t
    JOIN loops l ON l.id = t.loop_id
    WHERE l.session_id = $session_id
      AND (t.producer = 'model' OR t.kind = 'initialization')
) AS present;

-- PREP: engine_session_unread_agents
-- {§session-initialization-entry} Whether session://<session>/AGENTS.md exists at a revision this
-- session has not yet READ (including after session/resume, session/fork, or mid-session role edits).
WITH current_entry AS (
    SELECT e.id
    FROM entries e
    JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
    WHERE e.workspace_id = $workspace_id
      AND e.scheme = 'session'
      AND e.authority = $session_name
      AND e.pathname = '/AGENTS.md'
),
last_read AS (
    SELECT le.id, le.inherited_history, l.sequence AS loop_seq, t.sequence AS turn_seq, le.sequence AS entry_seq
    FROM log_entries le
    JOIN turns t ON t.id = le.turn_id
    JOIN loops l ON l.id = le.loop_id
    WHERE le.session_id = $session_id
      AND le.op = 'READ'
      AND le.scheme = 'session'
      AND le.pathname = '/AGENTS.md'
      AND (le.hostname = $session_name OR le.inherited_history = 1)
      AND le.state = 'resolved'
      AND le.status_rx IN (200, 204)
    ORDER BY le.id DESC
    LIMIT 1
),
effective_read AS (
    SELECT CASE
        WHEN lr.inherited_history = 0 THEN lr.id
        ELSE COALESCE((
            SELECT ple.id
            FROM sessions s
            JOIN loops pl ON pl.session_id = s.parent_session_id AND pl.sequence = lr.loop_seq
            JOIN turns pt ON pt.loop_id = pl.id AND pt.sequence = lr.turn_seq
            JOIN log_entries ple ON ple.turn_id = pt.id AND ple.sequence = lr.entry_seq
            WHERE s.id = $session_id
        ), lr.id)
    END AS read_id
    FROM last_read lr
),
last_mutation AS (
    SELECT MAX(m.id) AS mutation_id
    FROM log_entries m
    JOIN sessions ms ON ms.id = m.session_id
    WHERE ms.workspace_id = $workspace_id
      AND m.state = 'resolved'
      AND m.status_rx BETWEEN 200 AND 299
      AND m.inherited_history = 0
      AND (
          (
              m.op = 'EDIT'
              AND m.scheme = 'session'
              AND m.pathname = '/AGENTS.md'
              AND (
                  m.hostname = $session_name
                  OR (
                      m.hostname = (SELECT ps.name FROM sessions s JOIN sessions ps ON ps.id = s.parent_session_id WHERE s.id = $session_id)
                      AND m.id <= COALESCE((SELECT MAX(ple.id) FROM sessions s JOIN log_entries ple ON ple.session_id = s.parent_session_id WHERE s.id = $session_id), 0)
                  )
              )
          )
          OR (
              m.op IN ('COPY', 'MOVE')
              AND json_valid(m.rx)
              AND EXISTS (
                  SELECT 1 FROM json_each(m.rx, '$.effects') effect
                  WHERE json_type(effect.value) = 'object'
                    AND json_extract(effect.value, '$.target') = 'session://' || $session_name || '/AGENTS.md'
              )
          )
      )
)
SELECT EXISTS (
    SELECT 1
    FROM current_entry
    WHERE (SELECT read_id FROM effective_read) IS NULL
       OR COALESCE((SELECT mutation_id FROM last_mutation), 0) > (SELECT read_id FROM effective_read)
) AS unread;
