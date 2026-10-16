-- {§worker-obligations} What a message records of the operation that sent it, and what each worker is held on.

-- PREP: test_message_openers
SELECT m.id, m.source, m.opened_turn_id, m.opened_sequence, s.sender_worker_id
FROM loop_messages m
LEFT JOIN message_senders s ON s.message_id = m.id
ORDER BY m.id;

-- PREP: test_worker_obligations
SELECT worker_id, streams, workers, messages FROM worker_obligations WHERE worker_id = $worker_id;
