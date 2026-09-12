-- ProposalLifecycle: resolving a proposed log row.

-- PREP: engine_resolve_log_entry
-- Transitions a proposed log entry to its terminal state. Used by the
-- proposal lifecycle (client resolution, auto resolution, timeout, abort).
-- Updates status_rx + rx + state + outcome atomically.
UPDATE log_entries
   SET state = $state,
       outcome = $outcome,
       status_rx = $status_rx,
       rx = $rx,
       weight = $weight,
       deep_hash = NULL
 WHERE id = $id
   AND state = 'proposed';

-- PREP: engine_log_entry_coordinate
-- Resolve a durable operation occurrence after a proposal settles so a
-- Problem Details instance names the same model-facing log URI as every
-- immediately failed operation.
SELECT l.sequence AS loop_seq,
       t.sequence AS turn_seq,
       le.sequence AS sequence,
       le.op AS op,
       le.origin AS origin,
       le.attrs AS attrs,
       le.tx AS tx,
       le.mimetype_tx AS mimetype_tx,
       le.mimetype_rx AS mimetype_rx
  FROM log_entries le
  JOIN turns t ON t.id = le.turn_id
  JOIN loops l ON l.id = le.loop_id
 WHERE le.id = $id;
