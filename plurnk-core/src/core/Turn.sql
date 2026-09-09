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
-- lifecycle transition after every admitted OP has settled.
UPDATE turns
SET packet = $packet,
    usage_curation_budget = $usage_curation_budget,
    finish_reason = $finish_reason,
    model = $model,
    meta = $meta
WHERE id = $id
  AND producer = 'model'
  AND kind = 'inference'
  AND completed_at IS NULL
  AND packet IS NULL
RETURNING id;

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
