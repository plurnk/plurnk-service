-- PacketBuilder: the request packet's sections, read from the durable log and session tree.

-- PREP: engine_sent_messages_open
-- {§child-orientation} {§loop-completion}: the messages this session sent to other sessions that await
-- completion, as `{status, path}` pointers beside its live children: the recipient loop's status, 100 queued,
-- 102 processing, 202 parked. A completed message, or one whose recipient loop ended, is no longer held.
SELECT m.path, l.status
FROM message_sources m
JOIN message_senders s ON s.message_id = m.id
JOIN loops l ON l.id = m.loop_id
WHERE s.sender_session_id = $session_id
  AND l.status IN (100, 102, 202)
  AND NOT EXISTS (SELECT 1 FROM message_completions c WHERE c.message_id = m.id)
ORDER BY m.id ASC;

-- PREP: engine_child_sessions_live
-- The session's LIVE child sessions — any loop non-terminal (100 pending / 102 processing / 202 parked).
-- Powers the Open Work sessions list ({§child-orientation}): terse `* <status> session://<name>`
-- pointers so the model SEES what it holds live and reasons for itself (read/kill), never told to.
-- Empty → section omitted.
SELECT r.name,
       CASE
           WHEN SUM(CASE WHEN l.status = 102 THEN 1 ELSE 0 END) > 0 THEN 102
           WHEN SUM(CASE WHEN l.status = 202 THEN 1 ELSE 0 END) > 0 THEN 202
           ELSE 100
       END AS status
FROM sessions r
JOIN loops l ON l.session_id = r.id AND l.status IN (100, 102, 202)
WHERE r.parent_session_id = $session_id AND l.status IN (100, 102, 202)
GROUP BY r.id, r.name
ORDER BY r.name;

-- PREP: engine_parent_session
-- The session's PARENT, when it has one — its name and the status of its latest loop. Powers the
-- The parent on the Session identity block ({§child-orientation}, #394): a child can only name its parent's
-- streams and space if it is told the name. Absent → section omitted.
SELECT p.name,
       COALESCE((SELECT l.status FROM loops l WHERE l.session_id = p.id ORDER BY l.id DESC LIMIT 1), 0) AS status
FROM sessions c JOIN sessions p ON p.id = c.parent_session_id
WHERE c.id = $session_id;

-- PREP: engine_child_streams_open
-- The session's OPEN streams (subscriptions not yet closed), one row per published channel with its
-- size, publication cursor and durable activity clock. Powers the Open Work streams
-- inventory ({§child-orientation}); output bodies remain explicit reads while active ({§exec-stream}).
SELECT s.scheme, e.authority, e.pathname, sp.id AS publication_id, ec.name AS channel,
    (length(ec.content) - length(replace(ec.content, char(10), ''))) AS lines,
    length(ec.content) AS bytes, sp.published_end AS reported,
    s.opened_at, s.output_changed_at
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
JOIN subscription_publications sp ON sp.subscription_id = s.id
JOIN entry_channels ec ON ec.entry_id = s.entry_id AND ec.name = sp.channel
WHERE s.session_id = $session_id AND s.closed_at IS NULL
ORDER BY e.pathname, ec.name;

-- PREP: engine_streams_reported
-- {§child-orientation} — every publication cursor a packet's Open Work pointers reported lands
-- in one statement ($observations is a JSON array of {publication_id, bytes}), so the next packet
-- can say how much each stream grew. A cursor only advances.
UPDATE subscription_publications
SET published_end = json_extract(observation.value, '$.bytes')
FROM json_each($observations) AS observation
WHERE subscription_publications.id = json_extract(observation.value, '$.publication_id')
  AND subscription_publications.published_end < json_extract(observation.value, '$.bytes');

-- PREP: engine_render_log_notices
-- {§operation-results} {§log-history-projection}: one-turn notices for log rows since
-- loops.notice_log_cursor: LogCoordinate pointers for stateful >=400 rows (active = 1),
-- and inline notices for stateless >=400 refusals, 204/304 mutation no-ops, and 200 log:/// curations (active = 0).
SELECT
    le.id,
    p.active,
    l.sequence AS loop_seq,
    t.sequence AS turn_seq,
    le.sequence,
    le.origin,
    le.op,
    le.signal,
    le.scheme,
    le.username,
    le.password,
    le.hostname,
    le.port,
    le.pathname,
    le.query,
    le.fragment,
    le.status_rx,
    le.rx,
    le.mimetype_rx,
    le.tx,
    le.mimetype_tx,
    le.initial_folded,
    p.folded,
    le.source,
    le.attrs,
    t.producer,
    CASE WHEN le.status_rx = 200 AND COALESCE(le.op, '') = 'kill' AND COALESCE(le.scheme, '') = 'log' THEN
        (SELECT COUNT(*) FROM log_curation_effects ce WHERE ce.operation_log_entry_id = le.id AND ce.active_after = 0)
    ELSE 0 END AS retired_count,
    CASE WHEN le.status_rx = 200 AND COALESCE(le.op, '') = 'kill' AND COALESCE(le.scheme, '') = 'log' THEN
        (SELECT COUNT(*) FROM log_curation_effects ce WHERE ce.operation_log_entry_id = le.id AND ce.active_after = 1)
    ELSE 0 END AS trimmed_count,
    CASE WHEN le.status_rx = 200 AND COALESCE(le.op, '') = 'kill' AND COALESCE(le.scheme, '') = 'log' THEN
        (SELECT json_group_array(resource) FROM (
            SELECT json_extract(CAST(rx_c.content AS TEXT), '$.resource') AS resource
            FROM log_curation_effects ce
            JOIN log_entry_rows target ON target.id = ce.target_log_entry_id
            JOIN contents rx_c ON rx_c.id = target.rx_content_id
            WHERE ce.operation_log_entry_id = le.id
              AND ce.active_after = 0
              AND target.op = 'send'
              AND target.mimetype_rx = 'application/json'
              AND json_valid(CAST(rx_c.content AS TEXT))
              AND json_type(CAST(rx_c.content AS TEXT), '$.resource') = 'text'
              AND json_extract(CAST(rx_c.content AS TEXT), '$.resource') GLOB 'message://*/*'
            ORDER BY ce.target_log_entry_id ASC
        ))
    ELSE NULL END AS retired_messages
FROM log_entries le
JOIN log_entry_projections p ON p.log_entry_id = le.id
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.loop_id = $loop_id
  AND le.id > l.notice_log_cursor
  AND NOT (le.status_rx = 202 AND le.state = 'proposed')
  AND NOT (le.origin = '_plurnk' AND COALESCE(le.source, '') = 'provider')
  AND NOT (
      t.producer = '_plurnk'
      AND t.kind = 'maintenance'
      AND COALESCE(le.status_rx, 200) < 400
      AND le.source IS NULL
  )
  AND (
      le.status_rx >= 400
      OR (p.active = 0 AND le.status_rx IN (204, 304))
      OR (p.active = 0 AND le.status_rx = 200 AND COALESCE(le.op, '') = 'kill' AND COALESCE(le.scheme, '') = 'log')
  )
  AND NOT (
      le.status_rx >= 400
      AND p.active = 0
      AND json_type(le.attrs, '$.runtime') = 'text'
      AND json_type(le.attrs, '$.pathname') = 'text'
      AND EXISTS (
          SELECT 1
          FROM sessions ws
          JOIN entries e ON e.workspace_id = ws.workspace_id
              AND e.scheme = 'exec'
              AND e.authority = ''
              AND e.pathname = json_extract(le.attrs, '$.pathname')
          JOIN subscriptions sub ON sub.entry_id = e.id AND sub.session_id = le.session_id
          WHERE ws.id = le.session_id
      )
  )
ORDER BY le.id ASC;

-- PREP: engine_log_notice_high_water
-- {§operation-results}: highest log_entry_rows.id eligible for notice acknowledgment on this packet,
-- stopping before any unresolved proposed row in the loop.
SELECT COALESCE(MAX(r.id), 0) AS max_id
FROM log_entry_rows r
WHERE r.loop_id = $loop_id
  AND r.id <= COALESCE((
      SELECT MIN(p.id) - 1
      FROM log_entry_rows p
      WHERE p.loop_id = $loop_id AND p.state = 'proposed'
  ), 9223372036854775807);

-- PREP: engine_advance_notice_log_cursor
-- {§operation-results}: monotonic cursor advance once a completed emission call has consumed the packet.
UPDATE loops
SET notice_log_cursor = MAX(notice_log_cursor, $cursor)
WHERE id = $loop_id AND notice_log_cursor < $cursor;

-- PREP: engine_emission_history
-- {§emission-history}: rank completed model and initialization turns across the session BEFORE testing eligibility.
WITH completed AS (
    SELECT t.id, l.sequence AS loop_seq, t.sequence AS turn_seq, t.packet,
           row_number() OVER (ORDER BY l.sequence DESC, t.sequence DESC) AS recency
    FROM turns t
    JOIN loops l ON l.id = t.loop_id
    WHERE l.session_id = $session_id
      AND (l.sequence < $current_loop_seq OR (l.id = $loop_id AND t.sequence < $current_turn_seq))
      AND ((t.producer = 'model' AND t.kind = 'inference') OR t.kind = 'initialization')
      AND t.completed_at IS NOT NULL
)
SELECT le.id, json_extract(le.rx, '$.content') AS content,
    CASE WHEN p.packet IS NOT NULL THEN json_extract(p.packet, '$.assistantRaw') ELSE NULL END AS assistant_raw,
    (SELECT json_group_array(DISTINCT runtime) FROM (
        SELECT json_extract(value, '$.runtime') AS runtime
        FROM json_each(CASE WHEN p.packet IS NOT NULL THEN p.packet ELSE '{}' END, '$.assistant.ops')
        WHERE json_type(value, '$.runtime') = 'text'
        UNION
        SELECT json_extract(op_le.tx, '$.runtime') AS runtime
        FROM log_entries op_le
        WHERE op_le.turn_id = p.id AND op_le.origin IN ('model', '_plurnk')
          AND json_valid(op_le.tx) AND json_type(op_le.tx, '$.runtime') = 'text'
    )) AS executors
FROM completed p
JOIN active_log_entries le ON le.turn_id = p.id AND json_extract(le.attrs, '$.kind') = 'emission'
WHERE ($latest_only = 0 OR p.recency = 1)
ORDER BY p.loop_seq, p.turn_seq;

-- PREP: engine_render_log
-- Render-time log-section assembly ({§packet}).
-- Yields log_entries for the whole session — the session's working
-- memory carries across loops, not just the
-- current loop. Coordinates append /<op> only for rows that represent an operation.
-- Status 202 entries in state='proposed' are model-invisible until resolved.
-- Packet suppression and deliberate trimming remain separate facts under
-- {§log-kill-scope}; the packet renderer combines them.
SELECT
    le.id,
    l.sequence  AS loop_seq,
    t.sequence  AS turn_seq,
    le.sequence,
    -- le.origin is attribution, never a render filter; the session's actor — {§actor-boundary} {§machine-processes}
    le.origin,
    le.op, le.signal,
    le.scheme, le.username, le.password,
    le.hostname, le.port, le.pathname,
    le.query, le.fragment,
    le.status_rx, le.rx, le.mimetype_rx,
    le.tx, le.mimetype_tx,
    le.state, le.outcome, le.initial_folded, le.folded,
    le.source, le.weight, le.attrs,
    -- {§turn-source-resources}: an emission row names its author, the producer of its turn.
    t.producer
FROM active_log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
-- WHERE renders exactly one session's log — {§actor-boundary} {§machine-processes}
-- Proposed rows wait for resolution ({§proposal}); a log-kill that worked
-- stays out of the packet ({§log-history-projection}).
-- Stateful >=400 outcomes remain visible ({§operation-results}).
WHERE le.session_id = $session_id
  AND NOT (le.status_rx = 202 AND le.state = 'proposed')
  AND NOT (
      COALESCE(le.op, '') = 'kill'
      AND COALESCE(le.scheme, '') = 'log'
      AND le.status_rx = 200
  )
  -- Successful maintenance-turn rows (doc reconciliation) never render: a
  -- receipt answers an asker and these turns have none. Rows stay durable and
  -- readable; failures remain visible ({§operation-results}).
  AND NOT (
      t.producer = '_plurnk'
      AND t.kind = 'maintenance'
      AND COALESCE(le.status_rx, 200) < 400
      AND le.source IS NULL
  )
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: engine_open_messages
-- {§message-completion}: packet order and targetless send share the published unresolved queue.
-- {§message-arrival}: the model sees the short address, and a sender only when it is
-- another actor rather than the transport that minted this very message.
SELECT m.id, m.log_entry_id, m.path, m.key_path, CASE WHEN m.source = m.path THEN NULL ELSE m.source END AS source
FROM unanswered_messages m
WHERE m.loop_id = $loop_id AND m.log_entry_id IS NOT NULL
ORDER BY m.ordinal ASC;

-- PREP: engine_session_latest_packet
-- {§session-model-selection}: the session's workspace, latest packet-bearing loop, and packet,
-- so a model switch can measure the session's current curated context against the target model's budget.
SELECT w.workspace_id, l.id AS loop_id, tp.packet
FROM turns t
JOIN turn_packets tp ON tp.id = t.id
JOIN loops l ON l.id = t.loop_id
JOIN sessions w ON w.id = l.session_id
WHERE l.session_id = $session_id AND t.packet IS NOT NULL
ORDER BY l.sequence DESC, t.sequence DESC
LIMIT 1;

-- PREP: engine_packet_policy_entries
-- {§packet-assembly} — project-tier root `AGENTS(.local).md` and session-tier
-- `session://<session>/AGENTS.md` that populate `system-policy` alongside the
-- global policy tier, ordered deterministically: project `AGENTS.md`, project
-- `AGENTS.local.md`, then `session://<session>/AGENTS.md`.
-- An outer join cannot flatten the entry_channels view, so this one reads its tables ({§content-store}).
SELECT
    e.scheme AS scheme,
    e.pathname AS pathname,
    w.project_root AS project_root,
    CAST(COALESCE(ec.buffer, b.content) AS TEXT) AS content
FROM entries e
JOIN workspaces w
    ON w.id = e.workspace_id
LEFT JOIN entry_channel_rows ec
    ON ec.entry_id = e.id
   AND ec.name = e.default_channel
LEFT JOIN contents b
    ON b.id = ec.content_id
WHERE e.workspace_id = $workspace_id
  AND (
      (e.scheme = 'file' AND e.authority = '' AND e.pathname IN ('AGENTS.md', '/AGENTS.md', 'AGENTS.local.md', '/AGENTS.local.md'))
      OR (e.scheme = 'session' AND e.authority = $session_name AND e.pathname IN ('AGENTS.md', '/AGENTS.md'))
  )
ORDER BY
    CASE
        WHEN e.scheme = 'file' AND e.pathname IN ('AGENTS.md', '/AGENTS.md') THEN 1
        WHEN e.scheme = 'file' AND e.pathname IN ('AGENTS.local.md', '/AGENTS.local.md') THEN 2
        ELSE 3
    END;
