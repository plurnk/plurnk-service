-- Fork a worker: deep-copy its log into a new worker in the same workspace (SPEC {§machine-processes} —
-- branch the log, share the world). loops → turns → entries are copied with their
-- folded body intervals and attribution (origin/source) intact; only the worker/loop/
-- turn ids are remapped. Nothing of the world is copied
-- ({§machine-processes-fork-shares-the-world}); workspace entries and the
-- overlay remain shared. The branch inherits the parent's ambient observation
-- cursor from the same initial fork snapshot as its copied log.

-- PREP: fork_get_worker
SELECT workspace_id, name, origin, ambient_event_cursor FROM workers WHERE id = $id;

-- PREP: fork_insert_worker
-- A new worker in the parent's workspace; lineage recorded via parent_worker_id ({§lifecycle-terms}).
INSERT INTO workers (workspace_id, name, parent_worker_id, origin)
VALUES ($workspace_id, $name, $parent_worker_id, $origin)
RETURNING id;

-- PREP: fork_set_ambient_cursor
-- Use the cursor captured before log copying. If the parent observes more while
-- the fork is in flight, the branch stays conservatively behind and replays the
-- copied event ids idempotently rather than skipping unseen history.
UPDATE workers SET ambient_event_cursor = $ambient_event_cursor WHERE id = $worker_id;

-- PREP: fork_get_loops
SELECT id, sequence, status, prompt, flags, terminal_result
FROM loops WHERE worker_id = $worker_id ORDER BY id;

-- PREP: fork_insert_loop
INSERT INTO loops (worker_id, sequence, status, prompt, flags, terminal_result)
VALUES ($worker_id, $sequence, $status, $prompt, $flags, $terminal_result)
RETURNING id;

-- PREP: fork_reidentify_loop_result
-- A forked loop is a new durable resource. Success results need no instance;
-- failure results identify the branch loop rather than the source row.
UPDATE loops
SET terminal_result = json_set(
    terminal_result,
    '$.problem.instance',
    'loop:///' || id
)
WHERE id = $loop_id
  AND json_type(terminal_result, '$.problem') = 'object';

-- PREP: fork_get_turns
-- All turns across the worker's loops, in order — loop_id is remapped by the caller.
SELECT t.id, t.loop_id, t.sequence, t.timestamp, t.status,
       t.packet, t.finish_reason, t.model
FROM turns t JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id ORDER BY t.id;

-- PREP: fork_insert_turn
INSERT INTO turns (loop_id, sequence, timestamp, status, packet, finish_reason, model)
VALUES ($loop_id, $sequence, $timestamp, $status, $packet, $finish_reason, $model)
RETURNING id;

-- PREP: fork_get_log_entries
-- worker_id is the branch's; loop_id/turn_id are remapped by the caller. The source `id` rides along so
-- the caller can carry {§log-item-tags} classifications across (old id → new id). origin/source (attribution)
-- and folded intervals ride along too. {§machine-processes-fork-copies-the-log}
SELECT id, loop_id, turn_id, sequence, at, origin, source, op, delimiter, signal,
       ambient_event_id,
       scheme, username, password, hostname, port, pathname, query, fragment,
       lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, weight,
       state, outcome, attrs, folded
FROM log_entries WHERE worker_id = $worker_id ORDER BY id;

-- PREP: fork_insert_log_entry
-- RETURNING the new id so the caller can copy the row's classifications onto it ({§log-item-tags}).
INSERT INTO log_entries (worker_id, loop_id, turn_id, sequence, at, origin, source, ambient_event_id, op, delimiter, signal, scheme, username, password, hostname, port, pathname, query, fragment, lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, weight, state, outcome, attrs, folded)
VALUES ($worker_id, $loop_id, $turn_id, $sequence, $at, $origin, $source, $ambient_event_id, $op, $delimiter, $signal, $scheme, $username, $password, $hostname, $port, $pathname, $query, $fragment, $lineMarker, $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $weight, $state, $outcome, $attrs, $folded)
RETURNING id;

-- PREP: fork_copy_log_tags
-- {§log-item-tags} + {§machine-processes-fork-copies-the-log} — a forked log row keeps its
-- classifications along with its folded body intervals.
INSERT OR IGNORE INTO log_tags (log_entry_id, tag)
SELECT $new_log_id, tag FROM log_tags WHERE log_entry_id = $old_log_id;

-- PREP: fork_get_log_curation_effects
-- Exact OPEN/FOLD event effects are part of the copied log history, not
-- process-local overflow recovery bookkeeping. Both row identities are remapped below.
SELECT effect.operation_log_entry_id, effect.target_log_entry_id,
       effect.folded_before, effect.folded_after,
       effect.tags_added, effect.tags_removed
FROM log_curation_effects effect
JOIN log_entries operation ON operation.id = effect.operation_log_entry_id
WHERE operation.worker_id = $worker_id
ORDER BY effect.operation_log_entry_id, effect.target_log_entry_id;

-- PREP: fork_insert_log_curation_effect
INSERT INTO log_curation_effects (
    operation_log_entry_id,
    target_log_entry_id,
    folded_before,
    folded_after,
    tags_added,
    tags_removed
)
VALUES (
    $operation_log_entry_id,
    $target_log_entry_id,
    $folded_before,
    $folded_after,
    $tags_added,
    $tags_removed
);

-- {§worker-scheme} — a fork inherits the parent's private entries, distinct
-- from the shared workspace world above: "fork = everything-in-common-but-name, then diverges". The
-- entries are deep-copied (new ids) with the owner remapped (parent → branch), so
-- the branch's scratch is independent — it edits its own without touching the parent's.

-- PREP: fork_get_private_entries
-- The parent's private entries. Attributes ride along; channel copying below
-- retains each content-addressed derivation pointer with its exact content.
SELECT id, scheme, pathname, attributes
FROM entries WHERE workspace_id = $workspace_id AND owner_id = $owner_id ORDER BY id;

-- PREP: fork_insert_private_entry
-- A private entry copy with the branch as owner. synced_sig/membership_origin are NULL
-- (scratch is never disk-synced nor a file member); version defaults 0.
INSERT INTO entries (workspace_id, owner_id, scheme, pathname, attributes)
VALUES ($workspace_id, $owner_id, $scheme, $pathname, $attributes)
RETURNING id;

-- PREP: fork_copy_entry_channels
-- Copy every source channel from the source entry to the copy. Deep projections
-- live on the shared artifact, not on either entry.
INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, deep_hash, state, producer_result)
SELECT $new_entry_id, name, content, mimetype, weight, content_hash, deep_hash, state, producer_result
FROM entry_channels WHERE entry_id = $old_entry_id;
