-- Fork a worker: deep-copy its log into a new worker in the same workspace (SPEC {§machine-processes} —
-- branch the log, share the world). loops → turns → entries are copied with their
-- durable event evidence and current projection intact; only the worker/loop/
-- turn ids are remapped. Nothing of the world is copied
-- ({§machine-processes-fork-shares-the-world}); workspace entries and the
-- overlay remain shared. The branch inherits the parent's ambient observation
-- cursor from the same initial fork snapshot as its copied log.

-- PREP: fork_get_worker
SELECT workspace_id, name, origin,
       model_route_id, spawn_model_route_id, reasoning_policy
FROM workers WHERE id = $id;

-- PREP: fork_insert_worker
-- A new child in the parent's workspace. A FORK captures the parent's cursor
-- and the occurrence high-water in this one INSERT; a fresh WORK passes 0 and
-- receives the ordinary creation baseline trigger instead.
INSERT INTO workers (
    workspace_id, name, parent_worker_id, origin,
    capability_bound, ambient_event_cursor, fork_event_boundary
)
SELECT $workspace_id, $name, $parent_worker_id, $origin, $capability_bound,
       CASE WHEN $fork_snapshot = 1 THEN parent.ambient_event_cursor ELSE NULL END,
       CASE WHEN $fork_snapshot = 1 THEN COALESCE((
           SELECT MAX(ae.id) FROM ambient_events ae WHERE ae.workspace_id = $workspace_id
       ), 0) ELSE NULL END
FROM workers parent
WHERE parent.id = $parent_worker_id
  AND parent.workspace_id = $workspace_id
RETURNING id;

-- PREP: fork_set_generation_policy
-- A branch copies durable worker policy by value, then diverges independently.
UPDATE workers
SET model_route_id = $model_route_id,
    spawn_model_route_id = $spawn_model_route_id,
    reasoning_policy = $reasoning_policy,
    version = version + 1
WHERE id = $worker_id;

-- PREP: fork_get_loops
SELECT id, sequence, status, prompt, policy, model_route_id, spawn_model_route_id,
       reasoning_policy, max_turns, terminal_result
FROM loops WHERE worker_id = $worker_id ORDER BY id;

-- PREP: fork_insert_loop
INSERT INTO loops (
    worker_id, sequence, status, prompt, policy, model_route_id,
    spawn_model_route_id, reasoning_policy, max_turns, terminal_result
)
VALUES (
    $worker_id, $sequence, $status, $prompt, $policy, $model_route_id,
    $spawn_model_route_id, $reasoning_policy, $max_turns, $terminal_result
)
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
SELECT t.id, t.loop_id, t.sequence, t.timestamp,
       t.producer, t.kind,
       t.status,
       COALESCE(t.completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS completed_at,
       t.usage_curation_budget, t.packet, t.finish_reason, t.model, t.meta
FROM turns t JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id ORDER BY t.id;

-- PREP: fork_insert_turn
INSERT INTO turns (
    loop_id, sequence, timestamp, producer, kind, status, completed_at,
    usage_curation_budget, packet, finish_reason, model, meta
)
VALUES (
    $loop_id, $sequence, $timestamp, $producer, $kind, $status, $completed_at,
    $usage_curation_budget, $packet, $finish_reason, $model, $meta
)
RETURNING id;

-- PREP: fork_get_log_entries
-- worker_id is the branch's; loop_id/turn_id are remapped by the caller. The source `id` rides along so
-- the caller can carry {§log-item-tags} classifications across (old id → new id). origin/source (attribution)
-- and initial/current projection ride along too. {§machine-processes-fork-copies-the-log}
SELECT id, loop_id, turn_id, sequence, at, origin, source, op, delimiter, signal,
       ambient_event_id,
       scheme, username, password, hostname, port, pathname, query, fragment,
       lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, weight,
       state, outcome, attrs, initial_folded,
       projection.active AS projection_active,
       projection.folded AS projection_folded
FROM log_entries
JOIN log_entry_projections projection ON projection.log_entry_id = log_entries.id
WHERE worker_id = $worker_id
ORDER BY id;

-- PREP: fork_insert_log_entry
-- RETURNING the new id so the caller can copy the row's classifications onto it ({§log-item-tags}).
INSERT INTO log_entries (worker_id, loop_id, turn_id, sequence, at, origin, source, ambient_event_id, inherited_history, op, delimiter, signal, scheme, username, password, hostname, port, pathname, query, fragment, lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, weight, state, outcome, attrs, initial_folded)
VALUES ($worker_id, $loop_id, $turn_id, $sequence, $at, $origin, $source, $ambient_event_id, 1, $op, $delimiter, $signal, $scheme, $username, $password, $hostname, $port, $pathname, $query, $fragment, $lineMarker, $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $weight, $state, $outcome, $attrs, $initial_folded)
RETURNING id;

-- PREP: fork_set_log_entry_projection
UPDATE log_entry_projections
SET active = $active,
    folded = $folded
WHERE log_entry_id = $log_entry_id;

-- PREP: fork_copy_log_tags
-- {§log-item-tags} + {§machine-processes-fork-copies-the-log} — a forked log row keeps its
-- classifications along with its folded body intervals.
INSERT OR IGNORE INTO log_tags (log_entry_id, tag)
SELECT $new_log_id, tag FROM log_tags WHERE log_entry_id = $old_log_id;

-- PREP: fork_get_log_curation_effects
-- Exact OPEN/FOLD event effects are part of the copied log history, not
-- process-local overflow recovery bookkeeping. Both row identities are remapped below.
SELECT effect.operation_log_entry_id, effect.target_log_entry_id,
       effect.active_before, effect.active_after,
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
    active_before,
    active_after,
    folded_before,
    folded_after,
    tags_added,
    tags_removed
)
VALUES (
    $operation_log_entry_id,
    $target_log_entry_id,
    $active_before,
    $active_after,
    $folded_before,
    $folded_after,
    $tags_added,
    $tags_removed
);

-- {§machine-processes-entry-inheritance} — core enumerates the parent's
-- Worker-owned entries; the registered scheme decides whether each is copied,
-- rederived, or omitted. A copied snapshot gets a new id and remapped owner.

-- PREP: fork_get_private_entries
-- The parent's Worker-owned entries. The caller applies each registered
-- scheme's {§manifest-entry-inheritance}; active entries are never eligible for
-- a snapshot because their process-local producer cannot be cloned.
SELECT e.id, e.scheme, e.authority, e.pathname, e.attributes,
       EXISTS (
           SELECT 1 FROM entry_channels c
           WHERE c.entry_id = e.id AND c.state = 'active'
       ) AS active
FROM entries e
WHERE e.owner_id = $owner_id
ORDER BY e.id;

-- PREP: fork_insert_private_entry
-- A private entry copy with the branch as owner. synced_sig/membership_origin are NULL
-- (scratch is never disk-synced nor a file member); version defaults 0.
INSERT INTO entries (owner_id, scheme, authority, pathname, attributes)
SELECT $owner_id, $scheme, $authority, $pathname, $attributes
FROM workers WHERE id = $owner_id AND workspace_id = $workspace_id
RETURNING id;

-- PREP: fork_copy_entry_channels
-- Copy every source channel from the source entry to the copy. Deep projections
-- live on the shared artifact, not on either entry.
INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, deep_hash, state, producer_result)
SELECT $new_entry_id, name, content, mimetype, weight, content_hash, deep_hash, state, producer_result
FROM entry_channels WHERE entry_id = $old_entry_id;
