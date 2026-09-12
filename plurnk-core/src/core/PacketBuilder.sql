-- PacketBuilder: the request packet's sections, read from the durable log and worker tree.

-- PREP: engine_child_workers_live
-- The worker's LIVE child workers — any loop non-terminal (100 pending / 102 processing / 202 parked).
-- Powers the Delegation workers list ({§child-orientation}): terse `* <status> worker://<name>`
-- pointers so the model SEES what it holds live and reasons for itself (READ/KILL), never told to.
-- Empty → section omitted.
SELECT r.name,
       CASE
           WHEN SUM(CASE WHEN l.status = 102 THEN 1 ELSE 0 END) > 0 THEN 102
           WHEN SUM(CASE WHEN l.status = 202 THEN 1 ELSE 0 END) > 0 THEN 202
           ELSE 100
       END AS status,
       json_group_array(json_object('id', l.id, 'scheduled_at', l.scheduled_at,
           'repeat_interval_ms', l.repeat_interval_ms, 'recurrence_root_loop_id', l.recurrence_root_loop_id))
           FILTER (WHERE l.scheduled_at IS NOT NULL) AS scheduled_tasks
FROM workers r
JOIN loops l ON l.worker_id = r.id AND l.status IN (100, 102, 202)
WHERE r.parent_worker_id = $worker_id AND l.status IN (100, 102, 202)
GROUP BY r.id, r.name
ORDER BY r.name;

-- PREP: engine_parent_worker
-- The worker's PARENT, when it has one — its name and the status of its latest loop. Powers the
-- The parent on the Worker identity block ({§child-orientation}, #394): a child can only name its parent's
-- streams and space if it is told the name. Absent → section omitted.
SELECT p.name,
       COALESCE((SELECT l.status FROM loops l WHERE l.worker_id = p.id ORDER BY l.id DESC LIMIT 1), 0) AS status
FROM workers c JOIN workers p ON p.id = c.parent_worker_id
WHERE c.id = $worker_id;

-- PREP: engine_child_streams_open
-- The worker's OPEN streams (subscriptions not yet closed), one row per published channel with its
-- size and the size last reported to the model (the publication cursor). Powers the Delegation streams
-- orienting section ({§child-orientation}): `* active <runtime>:///<coord> — <channel> N lines (+D)`
-- pointers the model READs/KILLs. Nothing else reaches the model while a stream is active
-- ({§exec-stream}). Empty → section omitted.
SELECT s.scheme, e.authority, e.pathname, sp.id AS publication_id, ec.name AS channel,
    (length(ec.content) - length(replace(ec.content, char(10), ''))) AS lines,
    length(ec.content) AS bytes, sp.published_end AS reported
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
JOIN subscription_publications sp ON sp.subscription_id = s.id
JOIN entry_channels ec ON ec.entry_id = s.entry_id AND ec.name = sp.channel
WHERE s.worker_id = $worker_id AND s.closed_at IS NULL
ORDER BY e.pathname, ec.name;

-- PREP: engine_streams_reported
-- {§child-orientation} — every publication cursor a packet's Delegation pointers reported lands
-- in one statement ($observations is a JSON array of {publication_id, bytes}), so the next packet
-- can say how much each stream grew. A cursor only advances.
UPDATE subscription_publications
SET published_end = json_extract(observation.value, '$.bytes')
FROM json_each($observations) AS observation
WHERE subscription_publications.id = json_extract(observation.value, '$.publication_id')
  AND subscription_publications.published_end < json_extract(observation.value, '$.bytes');

-- PREP: engine_render_errors
-- SPEC {§operation-results}: 4xx/5xx log rows are indexed in the packet's errors as
-- LogCoordinate pointers, forcing the model to confront failures instead of letting
-- them rot in log:///. Window = the current would-be model turn AND the immediately
-- preceding completed model turn: prior-model-turn for action failures the
-- model just caused, current-turn so a pre-generate engine error surfaces THIS turn
-- rather than a turn late. Packetless chronology never hides a model failure.
-- {§operation-result-uniform-error-channel}
WITH previous_model_turn AS (
    SELECT id
    FROM turns
    WHERE loop_id = $loop_id
      AND sequence < $current_turn_seq
      AND producer = 'model'
      AND kind = 'inference'
      AND completed_at IS NOT NULL
    ORDER BY sequence DESC
    LIMIT 1
)
SELECT
    le.origin, le.op, le.attrs, le.tx, le.sequence, le.status_rx, le.rx, le.mimetype_rx,
    le.scheme, le.pathname,
    t.sequence AS turn_seq, l.sequence AS loop_seq
FROM active_log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.loop_id = $loop_id
  AND le.status_rx >= 400
  -- {§log-row-self-explains}: every >=400 row points at ITSELF — the op row carries its failure
  -- message on its meta line (packet-wire), so the pointer leads to a record that states its why.
  AND (
      t.sequence = $current_turn_seq
      OR t.id = (SELECT id FROM previous_model_turn)
  )
ORDER BY t.sequence, le.sequence;

-- PREP: engine_render_log
-- Render-time log-section assembly ({§body-projection}).
-- Yields log_entries for the whole worker — the conversation's working
-- memory carries across loops within a worker, not just the
-- current loop. Coordinates append /<op> only for rows that represent an operation.
-- Status 202 entries in state='proposed' are model-invisible until resolved.
-- Packet suppression and deliberate trimming remain separate facts under
-- {§log-readable-projection}; the packet renderer combines them.
SELECT
    le.id,
    l.sequence  AS loop_seq,
    t.sequence  AS turn_seq,
    le.sequence,
    -- le.origin is attribution, never a render filter; the worker's actor — {§actor-boundary-origin-not-filter} {§machine-processes-worker-origin}
    le.origin,
    le.op, le.signal,
    le.scheme, le.username, le.password,
    le.hostname, le.port, le.pathname,
    le.query, le.fragment,
    le.status_rx, le.rx, le.mimetype_rx,
    le.tx, le.mimetype_tx,
    le.state, le.outcome, le.initial_folded, le.folded,
    le.source, le.weight, le.attrs,
    le.output_admission_turn_id, le.output_withheld
FROM active_log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
-- WHERE renders exactly one worker's log — {§actor-boundary-isolation} {§machine-processes-worker-is-its-log}
-- Proposed rows wait for resolution ({§proposal-proposed-hidden}); successful
-- log-KILL receipts stay out of the packet ({§log-kill-meta-operation}).
-- Every failed operation remains visible ({§operation-result-uniform-error-channel}).
WHERE le.worker_id = $worker_id
  AND NOT (le.status_rx = 202 AND le.state = 'proposed')
  AND NOT (
      (COALESCE(le.op, '') = 'KILL' AND COALESCE(le.scheme, '') = 'log')
      AND le.status_rx < 400
  )
  -- Successful maintenance-turn rows (doc reconciliation) never render: a
  -- receipt answers an asker and these turns have none. Rows stay durable and
  -- READ-able; failures remain visible ({§operation-result-uniform-error-channel}).
  AND NOT (
      t.producer = '_plurnk'
      AND t.kind = 'maintenance'
      AND COALESCE(le.status_rx, 200) < 400
      AND le.source IS NULL
  )
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: engine_admit_log_outputs
UPDATE log_entry_projections
SET output_admission_turn_id = $turn_id, output_withheld = $withheld
WHERE log_entry_id IN (SELECT value FROM json_each($ids))
  AND active = 1 AND output_admission_turn_id IS NULL;
