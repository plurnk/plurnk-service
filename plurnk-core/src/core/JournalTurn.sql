-- Journal-only turn helpers. Client and plurnk actor work needs an ordered
-- Turn container for log rows but does not assemble a model packet.

-- PREP: journal_turn_next_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: journal_turn_insert
INSERT INTO turns (loop_id, sequence, status)
VALUES ($loop_id, $sequence, 200)
RETURNING id, sequence;
