-- Producer-neutral turn lifecycle. A turn is an ordered durable operation
-- container; model request/response evidence is an optional specialization.

-- PREP: turn_open
INSERT INTO turns (loop_id, sequence, producer, kind, status, completed_at)
SELECT $loop_id,
       COALESCE(MAX(sequence), 0) + 1,
       $producer,
       $kind,
       102,
       NULL
FROM turns
WHERE loop_id = $loop_id
RETURNING id, sequence;

-- PREP: turn_record_inference
-- Preserve the exact admitted/request-only packet and provider metadata while
-- the operation sequence is still executing. Completion remains a separate
-- lifecycle transition after every admitted OP has settled. {§packet-items}: the
-- view's trigger stores the sections as content-addressed items and refuses a turn
-- that is not an open model inference turn.
INSERT INTO turn_inference_evidence (turn_id, packet, sections, usage_curation_budget, finish_reason, model, meta)
VALUES ($turn_id, $packet, $sections, $usage_curation_budget, $finish_reason, $model, $meta);

-- PREP: turn_complete
UPDATE turns
SET status = $status,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = $id
  AND completed_at IS NULL
RETURNING id;

-- PREP: turn_fail_open
-- Exception cleanup is idempotent across a run that may already have completed
-- one of several producer turns before a later sibling failed.
UPDATE turns
SET status = 500,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = $id
  AND completed_at IS NULL
RETURNING id;

-- INIT: turns_capture_wake_revision
-- {§loop-wake-identity}: each program observes independently, before its packet
-- is assembled. A completion during that program remains owed through parking.
DROP TRIGGER IF EXISTS turns_capture_wake_revision;
CREATE TRIGGER turns_capture_wake_revision
AFTER INSERT ON turns
BEGIN
    UPDATE loops
    SET observed_wake_revision = (SELECT wake_revision FROM workers WHERE id = loops.worker_id)
    WHERE id = NEW.loop_id AND status = 102;
END;

-- PREP: engine_loop_turn_seqs
-- Look up (loop_seq, turn_seq) for a given (loop_id, turn_id). Used by
-- #writeLog when an op needs to address itself or its output by log
-- coordinate (e.g. a shell stream at sh:///<loop_seq>/<turn_seq>/<sequence>/sh).
SELECT l.sequence AS loop_seq, t.sequence AS turn_seq
FROM loops l, turns t
WHERE l.id = $loop_id AND t.id = $turn_id;
