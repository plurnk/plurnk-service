-- {§session-obligations} What a message records of the operation that sent it, and what each session is held on.

-- PREP: test_message_openers
SELECT m.id, m.source, m.opened_turn_id, m.opened_sequence, s.sender_session_id
FROM loop_messages m
LEFT JOIN message_senders s ON s.message_id = m.id
ORDER BY m.id;

-- PREP: test_session_obligations
SELECT session_id, streams, sessions, messages FROM session_obligations WHERE session_id = $session_id;
