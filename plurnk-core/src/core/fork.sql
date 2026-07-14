-- Fork a run: deep-copy its log into a NEW run in the SAME session (SPEC §machine-processes —
-- branch the log, share the world). loops → turns → entries are copied with their
-- fold-state (expanded) and attribution (origin/source) intact; only the run/loop/
-- turn ids are remapped. Nothing of the world is copied (§machine-processes-fork-shares-the-world) — the session's entries and
-- overlay are shared. The §env-delta reconciliation snapshot (run_watermarks) is NOT
-- copied; the branch first-sights its world like any fresh run.

-- PREP: fork_get_run
SELECT session_id, name, origin FROM runs WHERE id = $id;

-- PREP: fork_insert_run
-- A new run in the parent's session; lineage recorded via parent_run_id (§lifecycle-terms).
INSERT INTO runs (session_id, name, parent_run_id, origin)
VALUES ($session_id, $name, $parent_run_id, $origin)
RETURNING id;

-- PREP: fork_count_branches
-- How many fork branches the parent already has — for a UNIQUE `<parent>-fork-<N>` default name, so N
-- self-forks of one parent are individually addressable (KILL/SEND/READ by name) instead of colliding
-- on a single `<parent>-fork` that run_resolve_by_name would resolve to the newest only (§run-scheme-fork).
SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = $parent_run_id AND name LIKE $name_prefix;

-- PREP: fork_get_loops
SELECT id, sequence, status, prompt, flags
FROM loops WHERE run_id = $run_id ORDER BY id;

-- PREP: fork_insert_loop
INSERT INTO loops (run_id, sequence, status, prompt, flags)
VALUES ($run_id, $sequence, $status, $prompt, $flags)
RETURNING id;

-- PREP: fork_get_turns
-- All turns across the run's loops, in order — loop_id is remapped by the caller.
SELECT t.id, t.loop_id, t.sequence, t.timestamp, t.status,
       t.usage_prompt, t.usage_completion, t.usage_cached, t.usage_cost_pico,
       t.packet, t.finish_reason, t.model
FROM turns t JOIN loops l ON l.id = t.loop_id
WHERE l.run_id = $run_id ORDER BY t.id;

-- PREP: fork_insert_turn
INSERT INTO turns (loop_id, sequence, timestamp, status, usage_prompt, usage_completion, usage_reasoning, usage_cached, usage_cost_pico, packet, finish_reason, model)
VALUES ($loop_id, $sequence, $timestamp, $status, $usage_prompt, $usage_completion, $usage_reasoning, $usage_cached, $usage_cost_pico, $packet, $finish_reason, $model)
RETURNING id;

-- PREP: fork_get_log_entries
-- run_id is the branch's; loop_id/turn_id are remapped by the caller. The source `id` rides along so
-- the caller can carry §log-region-tagging tags across (old id → new id). origin/source (attribution)
-- and expanded (fold-state) ride along too. §machine-processes-fork-copies-the-log
SELECT id, loop_id, turn_id, sequence, at, origin, source, op, suffix, signal,
       scheme, username, password, hostname, port, pathname, params, fragment,
       lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, tokens,
       state, outcome, attrs, expanded
FROM log_entries WHERE run_id = $run_id ORDER BY id;

-- PREP: fork_insert_log_entry
-- RETURNING the new id so the caller can copy the row's region tags onto it (§log-region-tagging).
INSERT INTO log_entries (run_id, loop_id, turn_id, sequence, at, origin, source, op, suffix, signal, scheme, username, password, hostname, port, pathname, params, fragment, lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, tokens, state, outcome, attrs, expanded)
VALUES ($run_id, $loop_id, $turn_id, $sequence, $at, $origin, $source, $op, $suffix, $signal, $scheme, $username, $password, $hostname, $port, $pathname, $params, $fragment, $lineMarker, $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $tokens, $state, $outcome, $attrs, $expanded)
RETURNING id;

-- PREP: fork_copy_log_tags
-- §log-region-tagging + §machine-processes-fork-copies-the-log — a forked log row keeps its region
-- tags along with its fold-state, so a branch inherits the parent's named working-sets.
INSERT INTO log_tags (log_entry_id, tag)
SELECT $new_log_id, tag FROM log_tags WHERE log_entry_id = $old_log_id;

-- §run-scheme — a fork inherits the parent's run-scope SCRATCH (its private workspace), distinct
-- from the shared session world above: "fork = everything-in-common-but-name, then diverges". The
-- entries are deep-copied (new ids) with the owner remapped in the pathname (parent → branch), so
-- the branch's scratch is independent — it edits its own without touching the parent's.

-- PREP: fork_get_run_scope_entries
-- The parent's run-scope entries (owner = the parent's run name, prefix `/<parent>/*`). deep_hash
-- and attributes ride along; copying the channels with their tokens keeps the deep_hash valid so
-- the next-turn pump skips re-derivation (the content is byte-identical).
SELECT id, scheme, pathname, deep_hash, attributes
FROM entries WHERE scope = 'run' AND session_id = $session_id AND pathname GLOB $owner_prefix ORDER BY id;

-- PREP: fork_insert_run_scope_entry
-- A run-scope entry copy with the owner-remapped pathname. synced_sig/membership_origin are NULL
-- (scratch is never disk-synced nor a file member); version defaults 0.
INSERT INTO entries (scope, session_id, scheme, pathname, deep_hash, attributes)
VALUES ('run', $session_id, $scheme, $pathname, $deep_hash, $attributes)
RETURNING id;

-- PREP: fork_copy_entry_channels
-- Copy every channel (body + derived graph/fts/embedding) from the source entry to the copy — one
-- statement, content/tokens/state preserved, so the deep_hash gate holds and nothing re-derives.
INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens, state)
SELECT $new_entry_id, name, content, mimetype, tokens, state FROM entry_channels WHERE entry_id = $old_entry_id;

-- PREP: fork_copy_entry_tags
INSERT INTO entry_tags (entry_id, tag)
SELECT $new_entry_id, tag FROM entry_tags WHERE entry_id = $old_entry_id;
