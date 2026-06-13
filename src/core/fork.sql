-- Fork a run: deep-copy its log into a NEW run in the SAME session (SPEC §14.8 —
-- branch the log, share the world). loops → turns → entries are copied with their
-- fold-state (indexed) and attribution (origin/source) intact; only the run/loop/
-- turn ids are remapped. Nothing of the world is copied — the session's entries and
-- overlay are shared. The §14.5 reconciliation snapshot (run_watermarks) is NOT
-- copied; the branch first-sights its world like any fresh run.

-- PREP: fork_get_run
SELECT session_id, name, persona FROM runs WHERE id = $id;

-- PREP: fork_insert_run
-- A new run in the parent's session; lineage recorded via parent_run_id (§0.1).
INSERT INTO runs (session_id, name, persona, parent_run_id)
VALUES ($session_id, $name, $persona, $parent_run_id)
RETURNING id;

-- PREP: fork_get_loops
SELECT id, sequence, status, prompt, flags, persona
FROM loops WHERE run_id = $run_id ORDER BY id;

-- PREP: fork_insert_loop
INSERT INTO loops (run_id, sequence, status, prompt, flags, persona)
VALUES ($run_id, $sequence, $status, $prompt, $flags, $persona)
RETURNING id;

-- PREP: fork_get_turns
-- All turns across the run's loops, in order — loop_id is remapped by the caller.
SELECT t.id, t.loop_id, t.sequence, t.timestamp, t.status,
       t.usage_prompt, t.usage_completion, t.usage_cached, t.usage_cost_pico,
       t.packet, t.finish_reason, t.model
FROM turns t JOIN loops l ON l.id = t.loop_id
WHERE l.run_id = $run_id ORDER BY t.id;

-- PREP: fork_insert_turn
INSERT INTO turns (loop_id, sequence, timestamp, status, usage_prompt, usage_completion, usage_cached, usage_cost_pico, packet, finish_reason, model)
VALUES ($loop_id, $sequence, $timestamp, $status, $usage_prompt, $usage_completion, $usage_cached, $usage_cost_pico, $packet, $finish_reason, $model)
RETURNING id;

-- PREP: fork_get_log_entries
-- Everything but the row id and run_id (run_id is the branch's; loop_id/turn_id are
-- remapped by the caller). origin/source (attribution) and indexed (fold-state) ride along.
SELECT loop_id, turn_id, sequence, at, origin, source, op, suffix, signal,
       scheme, username, password, hostname, port, pathname, params, fragment,
       lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, tokens,
       state, outcome, attrs, indexed
FROM log_entries WHERE run_id = $run_id ORDER BY id;

-- PREP: fork_insert_log_entry
INSERT INTO log_entries (run_id, loop_id, turn_id, sequence, at, origin, source, op, suffix, signal, scheme, username, password, hostname, port, pathname, params, fragment, lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, tokens, state, outcome, attrs, indexed)
VALUES ($run_id, $loop_id, $turn_id, $sequence, $at, $origin, $source, $op, $suffix, $signal, $scheme, $username, $password, $hostname, $port, $pathname, $params, $fragment, $lineMarker, $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $tokens, $state, $outcome, $attrs, $indexed);
