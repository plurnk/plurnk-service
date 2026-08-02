-- Client-origin turn helpers. Each dispatched client action creates a synthetic turn
-- inside the connection's client loop with an empty packet shape.

-- PREP: client_turn_next_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: client_turn_insert
INSERT INTO turns (loop_id, sequence, status, packet)
VALUES ($loop_id, $sequence, 200, $packet)
RETURNING id, sequence;
