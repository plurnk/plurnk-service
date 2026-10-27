-- ApplicationPort runLoop queries. SPEC {§methods}.

-- PREP: application_latest_packet_loop
-- {§methods-workspace-create}: the loop holding the session's latest packet, the one whose gauge the session reported last.
SELECT turns.loop_id AS id FROM turns
JOIN loops ON loops.id = turns.loop_id
WHERE loops.session_id = $session_id AND turns.packet IS NOT NULL
ORDER BY turns.id DESC
LIMIT 1;

-- PREP: application_list_session_loops
-- {§methods-workspace-create}: durable lifecycle projection for exterior adapters. {§loop-completion}: a loop is
-- opened by its first message's operation, named in the sender's own log.
SELECT loops.id, loops.session_id AS sessionId, loops.sequence, loops.status, loops.prompt,
       loops.prompt_source AS promptSource, loops.claimed_at AS claimedAt, loops.terminated_at AS terminatedAt,
       loops.terminal_result AS terminalResult, loops.wait_poll_at AS waitUntil,
       (SELECT COUNT(*)
          FROM turns
         WHERE turns.loop_id = loops.id
           AND turns.packet IS NOT NULL) AS packetCount,
       sender.session_id AS invocationSessionId,
       CASE WHEN o.id IS NULL THEN NULL
            ELSE printf('log:///%d/%d/%d/%s', sender.sequence, opened.sequence, o.sequence, o.op) END AS invocation
FROM work_loops AS loops
LEFT JOIN loop_messages first ON first.loop_id = loops.id AND first.ordinal = 1
LEFT JOIN turns opened ON opened.id = first.opened_turn_id
LEFT JOIN loops sender ON sender.id = opened.loop_id
LEFT JOIN log_entries o ON o.turn_id = first.opened_turn_id AND o.sequence = first.opened_sequence
WHERE loops.session_id = $session_id
ORDER BY loops.sequence;
