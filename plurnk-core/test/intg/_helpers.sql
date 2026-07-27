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
-- Minimal turn with empty packet shape.
INSERT INTO turns (loop_id, sequence, status, packet) VALUES ($loop_id, $sequence, $status, $packet) RETURNING id;

-- Generic data-access PREPs for test setup/assertion. Avoid one-off SQL in
-- test bodies — add a PREP here, name it test_*, and call it.

-- PREP: test_count_log_entries_by_turn
SELECT COUNT(*) AS n FROM log_entries WHERE turn_id = $turn_id;

-- PREP: test_log_sequencees_by_turn
SELECT sequence, status_rx, pathname, op FROM log_entries
WHERE turn_id = $turn_id
ORDER BY sequence;

-- PREP: test_ops_by_turn
-- op + origin + status for a turn's rows — distinguishes model-dispatched ops from engine foists (#566).
SELECT op, origin, status_rx FROM log_entries WHERE turn_id = $turn_id ORDER BY sequence;

-- PREP: test_get_log_expanded
SELECT le.expanded FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND l.sequence = $loop_seq AND t.sequence = $turn_seq AND le.sequence = $sequence;

-- PREP: test_get_loop_status
SELECT status FROM loops WHERE id = $id;

-- PREP: test_get_turn
SELECT id, loop_id, sequence, status,
       usage_prompt, usage_completion, usage_reasoning, usage_cached, usage_cost_usd,
       finish_reason, model, packet
FROM turns WHERE id = $id;

-- PREP: test_get_log_entry_by_id
SELECT id, status_rx, state, outcome, attrs, rx
FROM log_entries WHERE id = $id;

-- PREP: test_get_session_cost
SELECT cost_usd FROM workspaces WHERE id = $id;

-- PREP: test_get_run_cost
SELECT cost_usd FROM workers WHERE id = $id;

-- PREP: test_count_turns
SELECT COUNT(*) AS n FROM turns;

-- PREP: test_count_entries_by_session
SELECT COUNT(*) AS n FROM entries WHERE workspace_id = $workspace_id;

-- PREP: test_count_entries_by_session_scheme
SELECT COUNT(*) AS n FROM entries WHERE workspace_id = $workspace_id AND scheme = $scheme;

-- PREP: test_get_entry_by_path
SELECT id FROM entries
WHERE workspace_id = $workspace_id AND scheme = $scheme AND pathname = $pathname;

-- PREP: test_get_channel
SELECT content, mimetype, state FROM entry_channels
WHERE entry_id = $entry_id AND name = $name;

-- PREP: test_list_entry_tags
SELECT tag FROM entry_tags WHERE entry_id = $entry_id ORDER BY tag;

-- PREP: test_get_subscription
SELECT id, worker_id, entry_id, scheme, handle, closed_at, close_status, close_result
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

-- PREP: test_exec_close_status_by_session
-- The close_status the registry recorded for a workspace's most-recently-closed
-- stream of a scheme — proves the registry-routed reap (§worker-lifecycle-total-reap)
-- closed the subscription at 499, not just that a notification fired.
SELECT s.close_status FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
WHERE e.workspace_id = $workspace_id AND s.scheme = $scheme AND s.closed_at IS NOT NULL
ORDER BY s.closed_at DESC LIMIT 1;

-- PREP: test_seed_entry_session
-- Tests bypass scheme handlers when seeding state for visibility / render tests.
INSERT INTO entries (workspace_id, owner_id, scheme, pathname)
VALUES ($workspace_id, $owner_id, $scheme, $pathname)
RETURNING id;

-- PREP: test_seed_channel
INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens, state)
VALUES ($entry_id, $name, $content, $mimetype, 0, $state);

-- PREP: test_seed_entry_tag
INSERT INTO entry_tags (entry_id, tag) VALUES ($entry_id, $tag);

-- PREP: test_get_packet
SELECT packet FROM turns WHERE id = $id;

-- PREP: test_get_turn_status
SELECT status FROM turns WHERE id = $id;

-- PREP: test_list_turns_in_loop
SELECT id, sequence, status, packet FROM turns WHERE loop_id = $loop_id ORDER BY sequence;

-- PREP: test_log_entries_by_turn
SELECT sequence, status_rx, pathname, scheme, fragment, op, origin, signal, rx
FROM log_entries WHERE turn_id = $turn_id ORDER BY sequence;

-- PREP: test_log_entries_by_run
SELECT id, op, pathname, scheme, sequence, turn_id, loop_id, status_rx
FROM log_entries WHERE worker_id = $worker_id ORDER BY id;

-- PREP: test_log_tags_by_run
-- §log-region-tagging — a worker's log tags with the coordinate they sit on (fork-copy assertions).
SELECT (l.sequence || '/' || t.sequence || '/' || le.sequence) AS coordinate, lt.tag
FROM log_tags lt
JOIN log_entries le ON le.id = lt.log_entry_id
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id ORDER BY coordinate, lt.tag;

-- PREP: test_log_entries_by_loop
-- The model loop's own entries — robust to which run holds the loop (the model
-- runs in its OWN run now, §connection-lifecycle), so a test queries by the loopId it holds.
-- origin is the writer tier (model | client | plurnk) — lets a test assert an engine foist
-- (origin='plurnk') vs a model op without a second query.
SELECT id, op, pathname, scheme, sequence, turn_id, loop_id, status_rx, rx, expanded, origin, lineMarker
FROM log_entries WHERE loop_id = $loop_id ORDER BY id;

-- PREP: test_get_worker_id_by_loop
-- Resolve which run a loop lives in — the model loop is in the model's own worker.
SELECT worker_id FROM loops WHERE id = $loop_id;

-- PREP: test_run_lineage
-- A worker's workspace + fork parent — for proving a fork is a new worker in the same workspace.
SELECT workspace_id, parent_worker_id FROM workers WHERE id = $id;

-- PREP: test_get_log_rx_by_run_op
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

-- PREP: test_count_log_entries_by_run
SELECT COUNT(*) AS n FROM log_entries WHERE worker_id = $worker_id;

-- PREP: test_get_entry_by_id
SELECT pathname FROM entries WHERE id = $id;

-- PREP: test_first_log_entry_for_turn
SELECT * FROM log_entries WHERE turn_id = $turn_id ORDER BY sequence LIMIT 1;

-- PREP: test_set_loop_status
UPDATE loops
SET status = $status,
    terminal_result = $terminal_result
WHERE id = $id;

-- PREP: test_set_session_project_root
-- Sets workspaces.project_root for File-scheme intg tests. F.1 added the
-- column; F.5 made the File scheme read from it instead of an env var.
UPDATE workspaces SET project_root = $project_root WHERE id = $id;

-- PREP: test_read_log_entries_for_turn_by_op
SELECT status_rx FROM log_entries WHERE turn_id = $turn_id AND op = $op;

-- PREP: test_delete_entry
DELETE FROM entries WHERE id = $id;

-- PREP: test_delete_run
DELETE FROM workers WHERE id = $id;

-- PREP: test_count_subscriptions_for_entry
SELECT COUNT(*) AS n FROM subscriptions WHERE entry_id = $entry_id;

-- PREP: test_count_subscriptions_for_run
SELECT COUNT(*) AS n FROM subscriptions WHERE worker_id = $worker_id;

-- PREP: test_get_entry_id_by_pathname
SELECT id FROM entries WHERE pathname = $pathname;

-- PREP: test_count_entry_tags
SELECT COUNT(*) AS n FROM entry_tags WHERE entry_id = $entry_id;

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

-- PREP: test_tags_by_pathname
SELECT tag
FROM entries e
JOIN entry_tags t ON t.entry_id = e.id
WHERE e.pathname = $pathname
ORDER BY tag;

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
SELECT origin, op, status_rx FROM log_entries
WHERE origin = 'client'
ORDER BY id LIMIT 1;

-- PREP: test_get_body_by_pathname
SELECT ec.content
FROM entry_channels ec
JOIN entries e ON e.id = ec.entry_id
WHERE e.pathname = $pathname AND ec.name = 'body';

-- PREP: test_list_sessions
SELECT name FROM workspaces;

-- PREP: test_get_run_by_session
SELECT id FROM workers
WHERE workspace_id = $workspace_id AND origin = 'client'
ORDER BY id LIMIT 1;

-- PREP: test_get_loop_by_run
SELECT id FROM loops WHERE worker_id = $worker_id LIMIT 1;

-- PREP: test_count_loops_by_run
SELECT COUNT(*) AS n FROM loops WHERE worker_id = $worker_id;

-- PREP: test_list_channel_names
SELECT name FROM entry_channels WHERE entry_id = $entry_id ORDER BY name;

-- PREP: test_get_entry_id_by_scheme_pathname
SELECT id FROM entries WHERE scheme = $scheme AND pathname = $pathname;

-- PREP: test_list_entries_by_workspace_workspace_pathname
SELECT scheme, pathname FROM entries WHERE workspace_id = $workspace_id ORDER BY scheme, pathname;

-- PREP: test_count_log_entries_run_origin
SELECT COUNT(*) AS n FROM log_entries WHERE worker_id = $worker_id AND origin = $origin;

-- PREP: test_fts_search
SELECT e.pathname FROM entry_fts f
JOIN derivations d ON d.id = f.rowid
JOIN entries e ON e.deep_hash = d.deep_hash
WHERE f.content MATCH $query AND e.workspace_id = $workspace_id
ORDER BY e.pathname;

-- PREP: test_cosine
SELECT cosine($a, $b) AS sim;


-- PREP: test_all_loops
-- [§worker-delegation-inherits-flags] — every loop's persisted flags, delegation-tree-wide.
SELECT id, worker_id, flags FROM loops ORDER BY id;

-- PREP: test_workers_with_parent
-- Deterministic topology identity: real child workers, their names, and their parent edge.
SELECT id, name, parent_worker_id, origin FROM workers ORDER BY id;

-- PREP: test_edit_states
-- [§worker-delegation-inherits-flags] — EDIT rows' proposal states: a delegated child's EDIT
-- must land resolved (inherited auto), never proposed/cancelled into the void.
SELECT pathname, state FROM log_entries WHERE op = 'EDIT' AND origin = 'model' ORDER BY id;

-- PREP: test_all_packets
-- [§strikes-first-party-metadata] — every stored packet, to prove no section carries strike state.
SELECT packet FROM turns WHERE packet IS NOT NULL;

-- PREP: test_deep_hash
-- A workspace entry's stamped deep hash (any entry: the warm-completion proof).
SELECT deep_hash FROM entries WHERE workspace_id = $workspace_id AND deep_hash IS NOT NULL LIMIT 1;

-- PREP: test_ops_by_loop
-- [§fold-open-meta-operations] — every model-origin op row with its status.
SELECT op, status_rx FROM log_entries WHERE origin = 'model' ORDER BY id;

-- PREP: test_set_session_settings
-- Set the workspaces.settings JSON bag (client open-context) for a test.
UPDATE workspaces SET settings = $settings WHERE id = $id;

-- PREP: test_open_subscription_for_run
-- ($worker_id unused: the honesty tests' db holds exactly one spawn)
SELECT s.id FROM subscriptions s WHERE s.closed_at IS NULL AND $worker_id IS NOT NULL LIMIT 1;

-- PREP: test_entries_by_scheme_prefix
SELECT pathname FROM entries WHERE workspace_id = $workspace_id AND scheme = $scheme AND pathname LIKE $prefix ORDER BY pathname;

-- PREP: test_entries_with_hash_by_scheme_prefix
SELECT pathname, deep_hash FROM entries WHERE workspace_id = $workspace_id AND scheme = $scheme AND pathname LIKE $prefix ORDER BY pathname;

-- PREP: test_artifact_counts
SELECT count(DISTINCT d.id) AS artifacts, count(ee.derivation_id) AS vectors
FROM derivations d
LEFT JOIN entry_embeddings ee ON ee.derivation_id = d.id
WHERE d.deep_hash = $deep_hash AND d.state = 'complete';

-- PREP: test_derivation_interruption_state
SELECT e.deep_hash,
       (SELECT count(*) FROM derivations WHERE state = 'building') AS building,
       (SELECT count(*) FROM derivations WHERE state = 'complete') AS complete
FROM entries e
WHERE e.workspace_id = $workspace_id AND e.pathname = '/interrupted.md';

-- PREP: test_entries_by_pathname
SELECT id, scheme, pathname FROM entries WHERE pathname = $pathname;

-- PREP: test_count_embeddings
SELECT count(*) AS n
FROM entries e
JOIN derivations d ON d.deep_hash = e.deep_hash
JOIN entry_embeddings ee ON ee.derivation_id = d.id
WHERE e.id = $entry_id;

-- PREP: test_derivation_for_entry
SELECT d.id
FROM entries e
JOIN derivations d ON d.deep_hash = e.deep_hash
WHERE e.id = $entry_id;

-- PREP: test_derivation_disposition
SELECT d.disposition, d.reason, e.deep_hash
FROM entries e
JOIN derivations d ON d.deep_hash = e.deep_hash
WHERE e.id = $entry_id;

-- PREP: test_get_log_entry_attrs_by_turn
SELECT attrs FROM log_entries WHERE turn_id = $turn_id AND op = $op ORDER BY id DESC LIMIT 1;

-- PREP: test_embedding_insertion_order
SELECT e.pathname, min(ee.rowid) AS first_rowid
FROM entry_embeddings ee
JOIN derivations d ON d.id = ee.derivation_id
JOIN entries e ON e.deep_hash = d.deep_hash
GROUP BY e.pathname;

-- PREP: test_log_entries_by_run_op
SELECT pathname, source, tokens, attrs FROM log_entries WHERE worker_id = $worker_id AND op = $op ORDER BY id;

-- PREP: test_count_entries_by_scheme
SELECT count(*) AS n FROM entries WHERE scheme = $scheme;

-- PREP: test_count_model_https_default_reads
SELECT count(*) AS n
FROM log_entries
WHERE origin = 'model' AND op = 'READ' AND scheme = 'https' AND fragment IS NULL;

-- PREP: test_subscription_published_channel
SELECT published_channel FROM subscriptions WHERE id = $id;

-- PREP: test_log_entries_by_run_op_signal
SELECT signal FROM log_entries WHERE worker_id = $worker_id AND op = $op ORDER BY id;

-- PREP: test_log_entries_by_run_op_full
SELECT pathname, tx, rx, status_rx FROM log_entries WHERE worker_id = $worker_id AND op = $op ORDER BY id;

-- PREP: test_error_rows_for_run
SELECT rx FROM log_entries WHERE worker_id = $worker_id AND op = 'error';

-- PREP: test_send_rows_for_run
SELECT rx, status_rx FROM log_entries WHERE worker_id = $worker_id AND op = 'SEND';

-- PREP: test_runs_by_session
SELECT id, name, origin, parent_worker_id FROM workers WHERE workspace_id = $workspace_id ORDER BY id;

-- PREP: test_first_turn_for_loop
SELECT packet FROM turns WHERE loop_id = $loop_id ORDER BY sequence LIMIT 1;

-- PREP: test_prompt_expanded
SELECT expanded FROM log_entries WHERE scheme='prompt' AND op='READ' LIMIT 1;

-- PREP: test_turn_id_by_seq
SELECT id FROM turns WHERE loop_id = $loop_id AND sequence = $sequence;

-- PREP: test_count_op
SELECT COUNT(*) n FROM log_entries WHERE op = $op;

-- PREP: test_terminate_loop_after_turn
-- The fan-out race fixture: mark a loop terminal with terminated_at strictly AFTER the given
-- turn's timestamp (+2s), with a deliverable — a child concluding during the parent's generation.
UPDATE loops SET status = 200, terminal_result = json_object('status', 200), terminated_at = strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT timestamp FROM turns WHERE id = $turn_id), '+2 seconds'), terminal_message = 'the value is 42'
WHERE id = $loop_id;

-- PREP: test_probe_raw
SELECT (SELECT timestamp FROM turns WHERE id = $turn_id) AS tts,
       (SELECT terminated_at FROM loops WHERE id = $loop_id) AS cterm,
       (SELECT r.parent_worker_id FROM loops l JOIN workers r ON r.id = l.worker_id WHERE l.id = $loop_id) AS cparent;

-- PREP: test_stamp_terminated_after_turn
-- Companion to test_terminate_loop_after_turn: the loops_stamp_terminated_at trigger fires on the
-- status TRANSITION and re-stamps 'now', clobbering an in-same-statement terminated_at (a 1ms race
-- against the turn insert — a real flake). This second UPDATE touches terminated_at ONLY (no
-- status change → no trigger), so the fixture's +2s value survives deterministically.
UPDATE loops SET terminated_at = strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT timestamp FROM turns WHERE id = $turn_id), '+2 seconds')
WHERE id = $loop_id;

-- PREP: test_set_session_root
UPDATE workspaces SET project_root = $project_root WHERE id = $id;

-- PREP: test_count_null_scheme_entries
SELECT COUNT(*) n FROM entries WHERE workspace_id = $workspace_id AND scheme IS NULL;

-- PREP: test_list_loops_all
SELECT id, worker_id, status, terminated_at, terminal_message, terminated_by FROM loops ORDER BY id;

-- PREP: test_get_entry_attributes
SELECT attributes FROM entries WHERE workspace_id = $workspace_id AND scheme = $scheme AND pathname = $pathname;

-- PREP: test_embeddings_for_entry
SELECT ee.vector FROM entries e
JOIN derivations d ON d.deep_hash = e.deep_hash
JOIN entry_embeddings ee ON ee.derivation_id = d.id
WHERE e.id = $entry_id ORDER BY ee.chunk_seq;

-- PREP: test_seed_channel_hashed
INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens, content_hash, state)
VALUES ($entry_id, $name, $content, $mimetype, 0, $content_hash, $state);

-- PREP: test_count_stamped_deep_hash
SELECT COUNT(*) AS n FROM entries WHERE workspace_id = $workspace_id AND deep_hash IS NOT NULL;

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

-- PREP: test_set_origin
UPDATE entries SET membership_origin = $membership_origin WHERE workspace_id = $workspace_id AND pathname = $pathname;

-- PREP: test_count_rows_for_pathname
SELECT COUNT(*) AS n FROM entries WHERE scheme = 'file' AND pathname = $pathname;

-- PREP: test_get_origin
SELECT membership_origin FROM entries WHERE workspace_id = $workspace_id AND pathname = $pathname;
