-- Test-fixture PREP blocks. These are loaded only when tests open the DB
-- via openMigrated() (which scans test/intg/ in addition to migrations + src).
-- Production boot (bin/plurnk-service.ts) does NOT include this directory,
-- so test fixtures stay out of production.

-- PREP: test_insert_workspace
INSERT INTO workspaces (name) VALUES ($name) RETURNING id;

-- PREP: test_insert_worker
INSERT INTO workers (workspace_id, name, parent_worker_id) VALUES ($workspace_id, $name, $parent_worker_id) RETURNING id;

-- PREP: test_insert_loop
INSERT INTO loops (worker_id, sequence, prompt) VALUES ($worker_id, $sequence, $prompt) RETURNING id;

-- PREP: test_insert_turn
-- Minimal turn with a caller-supplied packet state.
INSERT INTO turns (loop_id, sequence, status, packet) VALUES ($loop_id, $sequence, $status, $packet) RETURNING id;

-- Generic data-access PREPs for test setup/assertion. Avoid one-off SQL in
-- test bodies — add a PREP here, name it test_*, and call it.

-- PREP: test_count_log_entries_by_turn
SELECT COUNT(*) AS n FROM log_entries WHERE turn_id = $turn_id;

-- PREP: test_log_sequencees_by_turn
SELECT sequence, status_rx, pathname, op FROM log_entries
WHERE turn_id = $turn_id
ORDER BY sequence;

-- PREP: test_get_log_expanded
SELECT le.expanded FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: test_log_curation_effects_by_worker
SELECT effect.operation_log_entry_id, effect.target_log_entry_id, effect.expanded_before,
       effect.tags_added, effect.tags_removed,
       operation.op, operation.turn_id,
       operation.sequence AS operation_sequence,
       target.sequence AS target_sequence
FROM log_curation_effects effect
JOIN log_entries operation ON operation.id = effect.operation_log_entry_id
JOIN log_entries target ON target.id = effect.target_log_entry_id
WHERE operation.worker_id = $worker_id
ORDER BY effect.operation_log_entry_id, effect.target_log_entry_id;

-- PREP: test_get_loop_status
SELECT status FROM loops WHERE id = $id;

-- PREP: test_get_loop_posture
SELECT flags, model_route_id, spawn_model_route_id, max_turns, orphan_source_loop_id
FROM loops WHERE id = $id;

-- PREP: test_prompt_paths_by_owner
SELECT pathname FROM entries
WHERE owner_id = $owner_id AND scheme = 'prompt'
ORDER BY CAST(substr(pathname, 2, instr(substr(pathname, 2), '/') - 1) AS INTEGER),
         CAST(substr(pathname, instr(substr(pathname, 2), '/') + 2) AS INTEGER);

-- PREP: test_get_turn
SELECT id, loop_id, sequence, status,
       finish_reason, model, packet
FROM turns WHERE id = $id;

-- PREP: test_turn_attempts
SELECT a.id, mc.sequence, mc.state, a.accepted, mc.response,
       mc.failure, a.parse_errors,
       mc.attributions, mc.finish_reason, mc.model, mc.timestamp, mc.completed_at
FROM turn_attempts a
JOIN model_calls mc ON mc.id = a.model_call_id
WHERE mc.turn_id = $turn_id
ORDER BY mc.sequence;

-- PREP: test_model_calls
SELECT mc.id, mc.sequence, mc.kind, mc.state, mc.response, mc.failure, mc.capacity,
       mc.attributions, mc.finish_reason, mc.model, mc.timestamp, mc.completed_at,
       le.id AS log_entry_id
FROM model_calls mc
LEFT JOIN log_entries le ON le.model_call_id = mc.id
WHERE mc.turn_id = $turn_id
ORDER BY mc.sequence;

-- PREP: test_provider_requests
SELECT pr.id, a.id AS turn_attempt_id, mc.sequence AS attempt_sequence, pr.sequence,
       pr.provider, pr.model, pr.state, pr.outcome, pr.status,
       pr.usage_input, pr.usage_output, pr.usage_total,
       pr.usage_input_no_cache, pr.usage_input_cache_read, pr.usage_input_cache_write,
       pr.usage_output_text, pr.usage_output_reasoning,
       pr.cost_kind, pr.cost_amount, pr.cost_currency, pr.cost_usd_equivalent,
       pr.cost_source, pr.cost_reason, pr.started_at, pr.completed_at
FROM provider_requests pr
JOIN model_calls mc ON mc.id = pr.model_call_id
LEFT JOIN turn_attempts a ON a.model_call_id = mc.id
WHERE mc.turn_id = $turn_id
ORDER BY mc.sequence, pr.sequence;

-- PREP: test_get_log_entry_by_id
SELECT id, status_rx, state, outcome, attrs, rx
FROM log_entries WHERE id = $id;

-- PREP: test_count_turns
SELECT COUNT(*) AS n FROM turns;

-- PREP: test_count_provider_requests
SELECT COUNT(*) AS n FROM provider_requests;

-- PREP: test_count_entries_by_workspace
SELECT COUNT(*) AS n FROM entries WHERE workspace_id = $workspace_id;

-- PREP: test_count_entries_by_workspace_scheme
SELECT COUNT(*) AS n FROM entries WHERE workspace_id = $workspace_id AND scheme = $scheme;

-- PREP: test_get_entry_by_path
SELECT id, attributes FROM entries
WHERE workspace_id = $workspace_id AND scheme = $scheme AND pathname = $pathname;

-- PREP: test_get_channel
SELECT content, mimetype, weight, state FROM entry_channels
WHERE entry_id = $entry_id AND name = $name;

-- PREP: test_get_subscription
SELECT id, worker_id, entry_id, scheme, handle, poll_seconds, closed_at, close_status, close_result
FROM subscriptions WHERE id = $id;

-- PREP: test_get_subscription_by_entry
SELECT id, worker_id, entry_id, scheme, handle, closed_at, close_status, close_result
FROM subscriptions WHERE worker_id = $worker_id AND entry_id = $entry_id;

-- PREP: test_count_active_subscriptions
SELECT COUNT(*) AS n FROM subscriptions WHERE closed_at IS NULL;

-- PREP: test_count_open_subs_by_scheme
-- Open (un-closed) subscriptions for a workspace's scheme — the deterministic
-- "the backgrounded exec is live and killable" signal a cancel test waits on,
-- instead of racing a fixed sleep against the spawn.
SELECT COUNT(*) AS n FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
WHERE e.workspace_id = $workspace_id AND s.scheme = $scheme AND s.closed_at IS NULL;

-- PREP: test_exec_close_status_by_workspace
-- The close_status the registry recorded for a workspace's most-recently-closed
-- stream of a scheme — proves the registry-routed reap ({§worker-lifecycle-total-reap})
-- closed the subscription at 499, not just that a notification fired.
SELECT s.close_status FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
WHERE e.workspace_id = $workspace_id AND s.scheme = $scheme AND s.closed_at IS NOT NULL
ORDER BY s.closed_at DESC LIMIT 1;

-- PREP: test_seed_entry_workspace
-- Tests bypass scheme handlers when seeding state for visibility / render tests.
INSERT INTO entries (workspace_id, owner_id, scheme, pathname)
VALUES ($workspace_id, $owner_id, $scheme, $pathname)
RETURNING id;

-- PREP: test_seed_channel
INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, state)
VALUES ($entry_id, $name, $content, $mimetype, 0, $state);

-- PREP: test_get_packet
SELECT packet FROM turns WHERE id = $id;

-- PREP: test_get_turn_status
SELECT status FROM turns WHERE id = $id;

-- PREP: test_list_turns_in_loop
SELECT id, sequence, status, packet FROM turns WHERE loop_id = $loop_id ORDER BY sequence;

-- PREP: test_log_entries_by_turn
SELECT sequence, status_rx, pathname, scheme, fragment, op, origin, signal, rx, attrs, weight, model_call_id
FROM log_entries WHERE turn_id = $turn_id ORDER BY sequence;

-- PREP: test_log_entries_by_worker
SELECT id, ambient_event_id, op, pathname, scheme, sequence, turn_id, loop_id, status_rx, origin
FROM log_entries WHERE worker_id = $worker_id ORDER BY id;

-- PREP: test_log_tags_by_worker
-- {§log-item-tags} — a worker's log tags with the coordinate they classify.
SELECT (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate, lt.tag
FROM log_tags lt
JOIN log_entries le ON le.id = lt.log_entry_id
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id ORDER BY coordinate, lt.tag;

-- PREP: test_log_entries_by_loop
-- The model loop's own entries, independent of which worker owns it
-- ({§connection-lifecycle}), so a test queries by the loopId it holds.
-- origin is the writer tier (model | client | plurnk) — lets a test assert an engine foist
-- (origin='plurnk') vs a model op without a second query.
SELECT id, op, pathname, scheme, hostname, sequence, turn_id, loop_id, status_rx, signal, tx, rx, expanded, origin, lineMarker, attrs
FROM log_entries WHERE loop_id = $loop_id ORDER BY id;

-- PREP: test_get_worker_id_by_loop
-- Resolve which worker owns a loop — model loops belong to model workers.
SELECT worker_id FROM loops WHERE id = $loop_id;

-- PREP: test_worker_lineage
-- A worker's workspace + fork parent — for proving a fork is a new worker in the same workspace.
SELECT workspace_id, parent_worker_id FROM workers WHERE id = $id;

-- PREP: test_get_log_rx_by_worker_op
-- Forensic read-back for read-only ops in live tests: the latest rx the engine
-- recorded for a given op in a worker (e.g. what a READ<L> actually sliced).
SELECT rx FROM log_entries WHERE worker_id = $worker_id AND op = $op ORDER BY id DESC LIMIT 1;

-- PREP: test_count_log_entries
SELECT COUNT(*) AS n FROM log_entries;

-- PREP: test_count_entries
SELECT COUNT(*) AS n FROM entries;

-- PREP: test_count_channels_for_entry
SELECT COUNT(*) AS n FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: test_list_channels_for_entry
SELECT name, content, mimetype, state FROM entry_channels WHERE entry_id = $entry_id ORDER BY name;

-- PREP: test_channel_hashes_for_entry
SELECT name, deep_hash, content_hash FROM entry_channels WHERE entry_id = $entry_id ORDER BY name;

-- PREP: test_set_entry_updated_at
UPDATE entries SET updated_at = $updated_at WHERE id = $entry_id;

-- PREP: test_entry_updated_at
SELECT updated_at FROM entries WHERE id = $entry_id;

-- PREP: test_count_log_entries_by_worker
SELECT COUNT(*) AS n FROM log_entries WHERE worker_id = $worker_id;

-- PREP: test_get_entry_by_id
SELECT workspace_id, owner_id, scheme, pathname FROM entries WHERE id = $id;

-- PREP: test_first_log_entry_for_turn
SELECT * FROM log_entries WHERE turn_id = $turn_id ORDER BY sequence LIMIT 1;

-- PREP: test_set_loop_status
UPDATE loops
SET status = $status,
    terminal_result = $terminal_result
WHERE id = $id;

-- PREP: test_set_workspace_project_root
-- Sets workspaces.project_root for File-scheme intg tests. F.1 added the
-- column; F.5 made the File scheme read from it instead of an env var.
UPDATE workspaces SET project_root = $project_root WHERE id = $id;

-- PREP: test_read_log_entries_for_turn_by_op
SELECT status_rx FROM log_entries WHERE turn_id = $turn_id AND op = $op;

-- PREP: test_delete_entry
DELETE FROM entries WHERE id = $id;

-- PREP: test_delete_worker
DELETE FROM workers WHERE id = $id;

-- PREP: test_count_subscriptions_for_entry
SELECT COUNT(*) AS n FROM subscriptions WHERE entry_id = $entry_id;

-- PREP: test_count_subscriptions_for_worker
SELECT COUNT(*) AS n FROM subscriptions WHERE worker_id = $worker_id;

-- PREP: test_latest_subscription_for_worker
SELECT entry_id, close_status FROM subscriptions
WHERE worker_id = $worker_id
ORDER BY id DESC
LIMIT 1;

-- PREP: test_get_entry_id_by_pathname
SELECT id FROM entries WHERE pathname = $pathname;

-- PREP: test_get_entry_by_pathname_scheme
SELECT id, scheme, pathname FROM entries WHERE pathname = $pathname AND scheme = $scheme;

-- PREP: test_get_channel_by_pathname
SELECT ec.content, ec.mimetype, ec.state
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.pathname = $pathname AND ec.name = $name
LIMIT 1;

-- PREP: test_get_channel_by_pathname_scheme
SELECT ec.content, ec.mimetype, ec.state
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.pathname = $pathname AND e.scheme = $scheme AND ec.name = $name
LIMIT 1;

-- PREP: test_list_entry_schemes
SELECT scheme FROM entries ORDER BY scheme;

-- PREP: test_invalid_subscription_only_closed_at
-- Used to verify the closed_at + close_status pairing CHECK constraint.
INSERT INTO subscriptions (worker_id, entry_id, scheme, handle, closed_at)
VALUES ($worker_id, $entry_id, 'sse', 'h', '2026-01-01T00:00:00Z');

-- PREP: test_invalid_subscription_only_close_status
INSERT INTO subscriptions (worker_id, entry_id, scheme, handle, close_status)
VALUES ($worker_id, $entry_id, 'sse', 'h', 200);

-- PREP: test_first_log_entry
SELECT id, worker_id, origin, op, status_rx FROM log_entries
WHERE origin = 'client'
ORDER BY id LIMIT 1;

-- PREP: test_get_body_by_pathname
SELECT ec.content
FROM entry_channels ec
JOIN entries e ON e.id = ec.entry_id
WHERE e.pathname = $pathname AND ec.name = 'body';

-- PREP: test_list_workspaces
SELECT name FROM workspaces;

-- PREP: test_get_client_worker_by_workspace
SELECT id FROM workers
WHERE workspace_id = $workspace_id AND origin = 'client'
ORDER BY id LIMIT 1;

-- PREP: test_get_loop_by_worker
SELECT id FROM loops WHERE worker_id = $worker_id LIMIT 1;

-- PREP: test_count_loops_by_worker
SELECT COUNT(*) AS n FROM loops WHERE worker_id = $worker_id;

-- PREP: test_loop_queue_by_worker
SELECT id, sequence, status, prompt
FROM loops WHERE worker_id = $worker_id
ORDER BY sequence;

-- PREP: test_list_channel_names
SELECT name FROM entry_channels WHERE entry_id = $entry_id ORDER BY name;

-- PREP: test_get_entry_id_by_scheme_pathname
SELECT id FROM entries WHERE scheme = $scheme AND pathname = $pathname;

-- PREP: test_list_entries_by_workspace_workspace_pathname
SELECT scheme, pathname FROM entries WHERE workspace_id = $workspace_id ORDER BY scheme, pathname;

-- PREP: test_count_log_entries_worker_origin
SELECT COUNT(*) AS n FROM log_entries WHERE worker_id = $worker_id AND origin = $origin;

-- PREP: test_fts_search
SELECT e.pathname FROM derivation_fts f
JOIN derivations d ON d.id = f.rowid
JOIN entry_channels ec ON ec.deep_hash = d.deep_hash AND ec.name = 'body'
JOIN entries e ON e.id = ec.entry_id
WHERE f.content MATCH $query AND e.workspace_id = $workspace_id
ORDER BY e.pathname;

-- PREP: test_cosine
SELECT cosine($a, $b) AS sim;


-- PREP: test_all_loops
-- {§worker-delegation-inherits-flags} — every loop's persisted flags, delegation-tree-wide.
SELECT id, worker_id, flags, model_route_id, spawn_model_route_id, status FROM loops ORDER BY id;

-- PREP: test_workers_with_parent
-- Deterministic topology identity: real child workers, their names, and their parent edge.
SELECT id, name, parent_worker_id, origin FROM workers ORDER BY id;

-- PREP: test_workers_with_model
-- {§worker-model-selection} — every worker's durable model and persistent spawn override.
SELECT id, name, model_route_id, spawn_model_route_id FROM workers ORDER BY id;

-- PREP: test_edit_states
-- {§worker-delegation-inherits-flags} — EDIT rows' proposal states: a delegated child's EDIT
-- must land resolved (inherited auto), never proposed/cancelled into the void.
SELECT pathname, state FROM log_entries WHERE op = 'EDIT' AND origin = 'model' ORDER BY id;

-- PREP: test_all_packets
-- {§strikes-first-party-metadata} — every stored packet, to prove no section carries strike state.
SELECT packet FROM turns WHERE packet IS NOT NULL;

-- PREP: test_deep_hash
-- A workspace body's stamped deep hash (any body: the warm-completion proof).
SELECT ec.deep_hash FROM entry_channels ec
JOIN entries e ON e.id = ec.entry_id
WHERE e.workspace_id = $workspace_id AND ec.name = 'body' AND ec.deep_hash IS NOT NULL
LIMIT 1;

-- PREP: test_ops_by_loop
-- {§fold-open-meta-operations} — every model-origin op row with its status.
SELECT op, status_rx FROM log_entries WHERE origin = 'model' ORDER BY id;

-- PREP: test_set_workspace_settings
-- Set the workspaces.settings JSON bag (client open-context) for a test.
UPDATE workspaces SET settings = $settings WHERE id = $id;

-- PREP: test_open_subscription_for_worker
-- ($worker_id unused: the honesty tests' db holds exactly one spawn)
SELECT s.id FROM subscriptions s WHERE s.closed_at IS NULL AND $worker_id IS NOT NULL LIMIT 1;

-- PREP: test_entries_by_scheme_prefix
SELECT pathname FROM entries WHERE workspace_id = $workspace_id AND scheme = $scheme AND pathname LIKE $prefix ORDER BY pathname;

-- PREP: test_entries_with_hash_by_scheme_prefix
SELECT e.pathname, ec.deep_hash FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
WHERE e.workspace_id = $workspace_id AND e.scheme = $scheme AND e.pathname LIKE $prefix
ORDER BY e.pathname;

-- PREP: test_artifact_counts
SELECT count(DISTINCT d.id) AS artifacts, count(ee.derivation_id) AS vectors
FROM derivations d
LEFT JOIN derivation_embeddings ee ON ee.derivation_id = d.id
WHERE d.deep_hash = $deep_hash AND d.state = 'complete';

-- PREP: test_symbol_names_for_hash
SELECT name
FROM symbol_defs
WHERE derivation_id = (SELECT id FROM derivations WHERE deep_hash = $deep_hash)
ORDER BY name;

-- PREP: test_derivation_interruption_state
SELECT ec.deep_hash,
       (SELECT count(*) FROM derivations WHERE state = 'building') AS building,
       (SELECT count(*) FROM derivations WHERE state = 'complete') AS complete
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
WHERE e.workspace_id = $workspace_id AND e.pathname = '/interrupted.md';

-- PREP: test_derivation_state_counts
SELECT count(*) FILTER (WHERE state = 'building') AS building,
       count(*) FILTER (WHERE state = 'complete') AS complete
FROM derivations;

-- PREP: test_entries_by_pathname
SELECT id, scheme, pathname FROM entries WHERE pathname = $pathname;

-- PREP: test_count_embeddings
SELECT count(*) AS n
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
JOIN derivations d ON d.deep_hash = ec.deep_hash
JOIN derivation_embeddings ee ON ee.derivation_id = d.id
WHERE e.id = $entry_id;

-- PREP: test_derivation_for_entry
SELECT d.id
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
JOIN derivations d ON d.deep_hash = ec.deep_hash
WHERE e.id = $entry_id;

-- PREP: test_derivation_disposition
SELECT d.disposition, d.reason, ec.deep_hash
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
JOIN derivations d ON d.deep_hash = ec.deep_hash
WHERE e.id = $entry_id;

-- PREP: test_get_log_entry_attrs_by_turn
SELECT attrs FROM log_entries WHERE turn_id = $turn_id AND op = $op ORDER BY id DESC LIMIT 1;

-- PREP: test_insert_shared_edit_at
-- Cursor-contract fixture: two occurrences may deliberately share an arbitrary
-- wall-clock stamp. Delivery identity must come from the ambient event, not `at`.
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, at, origin, op,
    scheme, pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, $at, 'model', 'EDIT',
    'worker', $pathname, '', 'text/plain', $rx, 'application/json', 201
)
RETURNING id;

-- PREP: test_embedding_insertion_order
SELECT e.pathname, min(ee.rowid) AS first_rowid
FROM derivation_embeddings ee
JOIN derivations d ON d.id = ee.derivation_id
JOIN entry_channels ec ON ec.deep_hash = d.deep_hash AND ec.name = 'body'
JOIN entries e ON e.id = ec.entry_id
GROUP BY e.pathname;

-- PREP: test_log_entries_by_worker_op
SELECT pathname, source, weight, attrs FROM log_entries WHERE worker_id = $worker_id AND op = $op ORDER BY id;

-- PREP: test_model_emission_rows
SELECT id, turn_id, sequence, op, attrs FROM log_entries
WHERE worker_id = $worker_id
  AND op IS NULL
  AND json_extract(attrs, '$.kind') = 'model_emission'
ORDER BY id;

-- PREP: test_count_entries_by_scheme
SELECT count(*) AS n FROM entries WHERE scheme = $scheme;

-- PREP: test_subscription_published_channel
SELECT published_channel FROM subscriptions WHERE id = $id;

-- PREP: test_log_entries_by_worker_op_signal
SELECT signal FROM log_entries WHERE worker_id = $worker_id AND op = $op ORDER BY id;

-- PREP: test_log_entries_by_worker_op_full
SELECT pathname, tx, rx, mimetype_rx, status_rx, attrs
FROM log_entries WHERE worker_id = $worker_id AND op = $op ORDER BY id;

-- PREP: test_error_rows_for_worker
SELECT rx, weight FROM log_entries WHERE worker_id = $worker_id AND op = 'error';

-- PREP: test_send_rows_for_worker
SELECT rx, status_rx FROM log_entries WHERE worker_id = $worker_id AND op = 'SEND';

-- PREP: test_workers_by_workspace
SELECT id, name, origin, parent_worker_id, default_conversation
FROM workers WHERE workspace_id = $workspace_id ORDER BY id;

-- PREP: test_first_turn_for_loop
SELECT packet FROM turns WHERE loop_id = $loop_id ORDER BY sequence LIMIT 1;

-- PREP: test_prompt_expanded
SELECT expanded FROM log_entries WHERE scheme='prompt' AND op='prompt' LIMIT 1;

-- PREP: test_turn_id_by_seq
SELECT id FROM turns WHERE loop_id = $loop_id AND sequence = $sequence;

-- PREP: test_count_op
SELECT COUNT(*) n FROM log_entries WHERE op = $op;

-- PREP: test_set_workspace_root
UPDATE workspaces SET project_root = $project_root WHERE id = $id;

-- PREP: test_list_loops_all
SELECT id, worker_id, status, terminated_at, terminal_result, terminated_by FROM loops ORDER BY id;

-- PREP: test_get_entry_attributes
SELECT attributes FROM entries WHERE workspace_id = $workspace_id AND scheme = $scheme AND pathname = $pathname;

-- PREP: test_embeddings_for_entry
SELECT ee.vector FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
JOIN derivations d ON d.deep_hash = ec.deep_hash
JOIN derivation_embeddings ee ON ee.derivation_id = d.id
WHERE e.id = $entry_id ORDER BY ee.chunk_seq;

-- PREP: test_seed_channel_hashed
INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, state)
VALUES ($entry_id, $name, $content, $mimetype, 0, $content_hash, $state);

-- PREP: test_count_stamped_deep_hash
SELECT COUNT(*) AS n FROM entry_channels ec
JOIN entries e ON e.id = ec.entry_id
WHERE e.workspace_id = $workspace_id AND ec.name = 'body' AND ec.deep_hash IS NOT NULL;

-- PREP: test_get_turn_meta
SELECT meta FROM turns WHERE id = $id;

-- PREP: test_schema_version
SELECT user_version AS v FROM pragma_user_version;

-- PREP: test_count_entry_rows
SELECT COUNT(*) AS n FROM entries WHERE workspace_id = $workspace_id AND pathname = $pathname;

-- PREP: test_file_pathnames
SELECT pathname FROM entries WHERE workspace_id = $workspace_id AND scheme = 'file';

-- PREP: test_first_worker_for_ws
SELECT id FROM workers WHERE workspace_id = $workspace_id ORDER BY id LIMIT 1;

-- PREP: test_last_log_row
SELECT pathname, tx FROM log_entries WHERE loop_id = $loop_id ORDER BY id DESC LIMIT 1;

-- PREP: test_entry_deep_hash_by_path
SELECT ec.deep_hash
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
WHERE e.workspace_id = $workspace_id
  AND e.scheme = $scheme
  AND e.pathname = $pathname
LIMIT 1;

-- PREP: test_log_deep_hash_by_turn_sequence
SELECT deep_hash
FROM log_entries
WHERE turn_id = $turn_id
  AND sequence = $sequence
LIMIT 1;

-- PREP: test_set_origin
UPDATE entries SET membership_origin = $membership_origin WHERE workspace_id = $workspace_id AND pathname = $pathname;

-- PREP: test_count_rows_for_pathname
SELECT COUNT(*) AS n FROM entries WHERE scheme = 'file' AND pathname = $pathname;

-- PREP: test_get_origin
SELECT membership_origin FROM entries WHERE workspace_id = $workspace_id AND pathname = $pathname;
