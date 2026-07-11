-- Engine SQL. SPEC §arch (architecture), §scheme (op dispatch + log).

-- PREP: engine_loop_status
SELECT status FROM loops WHERE id = $loop_id;

-- PREP: engine_run_has_live_child
-- A non-terminal CHILD run (run:// spawn/fork set parent_run_id) — a "live thing the run holds",
-- like an open stream. A SEND[200] while one exists is a premature-terminate (§send-premature-terminate).
-- Live = a child whose LATEST loop is still pending/running/parked (100/102/202) — the SAME definition
-- engine_child_runs_live uses for the Child Runs orientation, so the 409 gate and the section the model
-- reads NEVER disagree: a refused termination is always backed by a child the model can SEE and KILL
-- (§child-orientation). An inherited/historical loop (a fork copies the parent's loops) is not the
-- latest, so it never makes a concluded child look forever-live.
SELECT 1 AS live FROM runs r
JOIN loops l ON l.id = (SELECT id FROM loops WHERE run_id = r.id ORDER BY sequence DESC, id DESC LIMIT 1)
WHERE r.parent_run_id = $run_id AND l.status IN (100, 102, 202) LIMIT 1;

-- PREP: engine_count_active_loops_for_run
-- Wake-on-completion uses this to decide whether to open a new loop or
-- let the existing one pick up the channel transition at the next turn
-- boundary. Status 102 = "in progress" (any non-terminal state).
SELECT COUNT(*) AS n FROM loops WHERE run_id = $run_id AND status = 102;

-- PREP: engine_get_loop_flags
-- Loads the loop's persisted flags (json). Default '{}'; YOLO listener and
-- SchemeRegistry.resolveForLoop merge over DEFAULT_LOOP_FLAGS for missing
-- fields. Migration 014.
SELECT flags FROM loops WHERE id = $loop_id;

-- PREP: engine_set_loop_flags
-- Updates the loop's persisted flags (json). Called by loop.run RPC handler.
UPDATE loops SET flags = $flags WHERE id = $loop_id;

-- PREP: engine_tag_loop_attributions
-- #249 — tag the loop with its active plugins' attribution tags (string[] JSON), write-once: the
-- active set is loop-stable, so the `= '[]'` guard keeps later turns from rewriting it.
UPDATE loops SET attributions = $attributions WHERE id = $loop_id AND attributions = '[]';

-- PREP: engine_set_loop_open_paths
-- #260 — persist the loop.run-passed @file paths (string[] JSON) on the loop before the drain
-- starts, so runTurn foists a turn-0 READ of each (same seam as the #250 AGENTS.md auto-read).
UPDATE loops SET open_paths = $open_paths WHERE id = $loop_id;

-- PREP: engine_get_loop_open_paths
-- #260 — runTurn reads the loop's @file foist-paths at turn 0.
SELECT open_paths FROM loops WHERE id = $loop_id;

-- PREP: engine_get_loop_prompt
-- Loop's prompt + sequence — runTurn reads it on turn 1 to foist a
-- system-origin EDIT against plurnk:///prompt/<loop_id>/1 (§packet), at the
-- turn's first action sequence. Prompts are first-class log entries
-- (no synthetic / shim layer).
SELECT prompt, sequence FROM loops WHERE id = $loop_id;

-- PREP: engine_reclaim_queued_loop
-- §run-lifecycle-wake-requeue-not-terminal — atomic 100→102 re-claim by loop id. A wake
-- re-queued this loop while ITS OWN live drain was between turns; the drain re-claims and
-- keeps running (the injected prompt is already the next turn). Conditional so a racing
-- claimant can never double-claim.
UPDATE loops SET status = 102 WHERE id = $loop_id AND status = 100;

-- PREP: engine_loop_set_status
-- The universal terminal setter. terminal_message carries either the loop's deliverable
-- (the SEND body) or the engine's abandonment reason (max_turns / budget_overflow /
-- strike_threshold) — rides the §run-scheme delta.
UPDATE loops SET status = $status, terminal_message = $message WHERE id = $loop_id;

-- PREP: engine_terminate_run_live_loops
-- §op-synchronous — KILL(run) is a DECISIVE op, not a fork/spawn/stream, so it must complete
-- before the turn moves on. Synchronously flip every LIVE loop of the run to 499 (killed) so the
-- same-turn premature-terminate gate (engine_run_has_live_child) sees it dead immediately; the
-- physical scope reap (drain abort, stream teardown) then proceeds async via cancelRun. The
-- loops_stamp_terminated_at trigger stamps terminated_at on the 499 transition (the §run-scheme delta).
UPDATE loops SET status = 499, terminal_message = $message
WHERE run_id = $run_id AND status IN (100, 102, 202);

-- PREP: session_get_settings
-- #231 — the session's client-chosen open-context bag ({ manifestItems?, mdDocs? }),
-- read at turn-0 with precedence over env.
SELECT settings FROM sessions WHERE id = $session_id;

-- PREP: engine_target_diverged_this_turn
-- #note10 — did this entry diverge on disk THIS turn? A source=file env-delta for the
-- target, materialized into this run's log at the current turn, means the model's view
-- predates the ambient change — a YOLO auto-accept of a same-turn EDIT would clobber it.
SELECT 1 AS hit
FROM log_entries
WHERE run_id = $run_id AND turn_id = $turn_id
  AND origin = 'plurnk' AND source = 'file' AND op = 'EDIT'
  AND scheme IS $scheme AND pathname = $pathname
LIMIT 1;

-- PREP: engine_list_session_entry_tags
-- #note13 — every (entry, tag) in the session, for the manifest catalog's tags field.
SELECT et.entry_id, et.tag
FROM entry_tags et
JOIN entries e ON e.id = et.entry_id
WHERE e.session_id = $session_id
ORDER BY et.entry_id, et.tag;

-- PREP: engine_list_run_entries
-- §run-scheme — the building run's OWN run-scope entries (catalogRowsFor source for a run-scope
-- FIND/foist). Byte-for-byte engine_list_session_entries but scope='run' + an owner-prefix glob
-- (`/<owner>/*`) so it yields exactly one run's scratch — its perspective, not a sibling's. Additive.
SELECT e.id AS entry_id, e.scheme, e.pathname, ec.name AS channel, ec.content, ec.mimetype, COALESCE(tc.tokens, ec.tokens) AS tokens, e.deep_hash,
    CAST(unixepoch('now') - unixepoch(s.opened_at) AS INTEGER) AS seconds
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
LEFT JOIN token_counts tc ON tc.content_hash = ec.content_hash AND tc.tokenizer_id = $tokenizer_id
LEFT JOIN subscriptions s ON s.entry_id = e.id AND s.closed_at IS NULL
WHERE e.scope = 'run' AND e.session_id = $session_id AND e.pathname GLOB $owner_prefix
ORDER BY e.updated_at ASC, e.id ASC, ec.name;

-- PREP: engine_list_run_entry_tags
-- §run-scheme — (entry, tag) for the building run's own run-scope entries (the run-scope catalog's tags field).
SELECT et.entry_id, et.tag
FROM entry_tags et
JOIN entries e ON e.id = et.entry_id
WHERE e.session_id = $session_id AND e.scope = 'run' AND e.pathname GLOB $owner_prefix
ORDER BY et.entry_id, et.tag;

-- PREP: engine_run_scratch_count
-- §run-scheme — distinct run-scope entry count owned by the building run, to decide whether the
-- turn-0 catalog foists a FIND(run:///**) (a run with no scratch foists nothing).
SELECT COUNT(DISTINCT e.id) AS entries
FROM entries e
WHERE e.scope = 'run' AND e.session_id = $session_id AND e.pathname GLOB $owner_prefix;

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_loop_usage
-- Per-loop usage totals — SUM the loop's turns (§tokenomics stores usage per turn).
-- Surfaced on loop.run + loop/terminated (#197). `context` is the LAST turn's prompt tokens — the
-- honest window-occupancy numerator (#263), distinct from the summed `prompt` (which overcounts a
-- context that grows across turns).
SELECT COALESCE(SUM(usage_prompt), 0)     AS prompt,
       COALESCE(SUM(usage_completion), 0) AS completion,
       COALESCE(SUM(usage_cost_pico), 0)  AS cost_pico,
       (SELECT usage_prompt FROM turns WHERE loop_id = $loop_id ORDER BY sequence DESC LIMIT 1) AS context,
       -- #274 — the LAST turn's model window (denominator), so numerator + denominator come from
       -- the same loop/model; NULL when the provider reports no window.
       (SELECT usage_context_size FROM turns WHERE loop_id = $loop_id ORDER BY sequence DESC LIMIT 1) AS context_size,
       -- #252 — the opaque provider meta blob from the LATEST turn (e.g. balancePico, a
       -- point-in-time snapshot; latest wins). Service-unenforced passthrough to the client.
       (SELECT meta FROM turns WHERE loop_id = $loop_id ORDER BY sequence DESC LIMIT 1) AS meta
FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_loop_turn_seqs
-- Look up (loop_seq, turn_seq) for a given (loop_id, turn_id). Used by
-- #writeLog when an op needs to address itself or its output by log
-- coordinate (e.g. EXEC's stream entry at exec:///<loop_seq>/<turn_seq>/<sequence>/EXEC).
SELECT l.sequence AS loop_seq, t.sequence AS turn_seq
FROM loops l, turns t
WHERE l.id = $loop_id AND t.id = $turn_id;

-- PREP: engine_open_turn
-- Turn-as-container model: insert a turn row at runTurn open with a
-- placeholder packet and status=102 (in-progress). Pre-model writes
-- (the user prompt; later, system signals/telemetry events) land into
-- this row before the provider is called. The turn is then "closed"
-- via engine_close_turn with the final packet + status + usage stats
-- after dispatch completes.
INSERT INTO turns (loop_id, sequence, status, packet)
VALUES ($loop_id, $sequence, 102, '{}')
RETURNING id;

-- PREP: engine_close_turn
-- Updates the turn with the response packet, terminal status, and
-- provider usage stats once dispatch is complete. Paired with
-- engine_open_turn at runTurn boundaries.
UPDATE turns SET
    status = $status,
    packet = $packet,
    usage_prompt = $usage_prompt,
    usage_completion = $usage_completion,
    usage_reasoning = $usage_reasoning,
    usage_cached = $usage_cached,
    usage_cost_pico = $usage_cost_pico,
    usage_context_size = $usage_context_size,
    finish_reason = $finish_reason,
    model = $model,
    meta = $meta
WHERE id = $id;

-- PREP: engine_list_session_entries
-- Every entry of a session — all schemes, all channels — the source behind the entry
-- catalog (catalogRowsFor / FIND) and the per-turn derivation pump (maintainDerivations).
-- Session-scoped (persists across runs); FOLD doesn't drop from the catalog.
-- `seconds` is the live age of an active stream: now − the open subscription's
-- opened_at (closed_at IS NULL). NULL for static entries. unixepoch parses the
-- stored '...%fZ' timestamp directly; re-evaluated every render like tokens.
SELECT e.id AS entry_id, e.scheme, e.pathname, ec.name AS channel, ec.content, ec.mimetype, COALESCE(tc.tokens, ec.tokens) AS tokens, e.deep_hash,
    CAST(unixepoch('now') - unixepoch(s.opened_at) AS INTEGER) AS seconds
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
LEFT JOIN token_counts tc ON tc.content_hash = ec.content_hash AND tc.tokenizer_id = $tokenizer_id
LEFT JOIN subscriptions s ON s.entry_id = e.id AND s.closed_at IS NULL
-- entries are session-scoped, shared across runs — §machine-processes-one-filesystem
WHERE e.scope = 'session' AND e.session_id = $session_id
-- User Note 5 — mtime-ascending: dormant entries hold the stable prompt-cache prefix; churn clusters at the tail.
ORDER BY e.updated_at ASC, e.id ASC, ec.name;

-- PREP: engine_scheme_catalog_summary
-- Per-scheme entry tally (distinct count; scheme=null → file). Sources the turn-0 per-scheme
-- foist so the model sees which schemes hold content without running FIND(known://**) itself;
-- the foist FIND carries each scheme's live token weight.
SELECT e.scheme AS scheme,
    COUNT(DISTINCT e.id) AS entries
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.scope = 'session' AND e.session_id = $session_id
GROUP BY e.scheme
ORDER BY e.scheme;

-- PREP: engine_run_prior_turn_time
-- §env-delta — timestamp of this run's most recent turn BEFORE the current one
-- (the "since I last looked" boundary). NULL on the run's first turn → no deltas.
SELECT MAX(t.timestamp) AS since
FROM turns t JOIN loops l ON l.id = t.loop_id
WHERE l.run_id = $run_id AND t.id != $turn_id;

-- PREP: engine_pull_env_deltas
-- §env-delta — other actors' resolved EDITs on shared entries since this run last
-- looked. Real edits (origin model/client) AND the plurnk run's fs-sync fictions
-- (origin=plurnk on the reserved 'plurnk' run); excludes this run's own rows and
-- other runs' already-materialized deltas (origin=plurnk on a real run). plurnk:///
-- entries (manifest/prompt/doc) never surface. This is the environment door (§actor-boundary-two-doors); the voice door is inject.
SELECT le.run_id, le.scheme, le.pathname, le.rx, le.source
FROM log_entries le
JOIN runs r ON r.id = le.run_id
WHERE r.session_id = $session_id
  AND le.op = 'EDIT'
  AND le.state = 'resolved'
  AND le.status_rx IN (200, 201)
  AND (le.scheme IS NULL OR le.scheme != 'plurnk')
  AND le.run_id != $run_id
  AND le.at > $since
  AND (le.origin != 'plurnk'
       OR le.run_id = (SELECT id FROM runs WHERE session_id = $session_id AND name = 'plurnk'))
ORDER BY le.at;

-- PREP: engine_insert_env_delta
-- §env-delta — materialize a pulled cross-actor edit as a FOLDED delta (expanded=0)
-- in this run's log. origin=plurnk; source carries the cause (sibling run id or
-- 'file'); rx reuses the originating row's result span (§edit-result-render).
INSERT INTO log_entries (
    run_id, loop_id, turn_id, sequence, origin, source,
    op, scheme, pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx, expanded
) VALUES (
    $run_id, $loop_id, $turn_id, $sequence, 'plurnk', $source,
    'EDIT', $scheme, $pathname, '', 'text/plain', $rx, 'application/json', 200, 0
);

-- PREP: engine_run_stream_channels
-- §exec-stream — every stream channel the run owns (an EXEC's stdout/stderr live on the
-- runtime-tag entry), with content + state + coordinate, so the per-turn injector can emit the
-- channel's unshown byte-delta. Stays listed until its last delta is shown (cursor == content len).
SELECT s.id AS subscription_id, e.scheme AS runtime, e.pathname AS coord,
    ec.name AS channel, ec.content AS content, ec.state AS state, s.close_status AS close_status
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
JOIN entry_channels ec ON ec.entry_id = s.entry_id
WHERE s.run_id = $run_id
ORDER BY s.id, ec.name;

-- PREP: engine_stream_cursor
-- §exec-stream — bytes of this channel already shown to the run: the streamEnd recorded on its
-- latest foisted delta (the caller defaults to 0 when none exists yet).
SELECT attrs
FROM log_entries
WHERE run_id = $run_id AND origin = 'plurnk' AND op = 'READ'
    AND scheme = $scheme AND pathname = $pathname AND fragment = $fragment
ORDER BY id DESC LIMIT 1;

-- PREP: engine_insert_stream_delta
-- §exec-stream / §env-delta — materialize a channel's unshown byte-delta as a
-- foisted READ@200 row (the model READs the stream it never typed). origin=plurnk; fragment is
-- the channel; attrs.streamEnd is the next turn's cursor; expanded=1 when the channel has CLOSED
-- (the terminal delta auto-OPENs), 0 while it streams (ongoing deltas fold). §exec-stream
INSERT INTO log_entries (
    run_id, loop_id, turn_id, sequence, origin, source,
    op, scheme, pathname, fragment, tx, mimetype_tx, rx, mimetype_rx, status_rx, attrs, expanded
) VALUES (
    $run_id, $loop_id, $turn_id, $sequence, 'plurnk', NULL,
    'READ', $scheme, $pathname, $fragment, '', 'text/plain', $rx, 'application/json', 200, $attrs, $expanded
);

-- PREP: engine_pull_loop_terminations
-- §run-scheme — sibling runs' loops that reached a terminal status since this run last
-- looked (the loop-termination ambient delta). Carries terminal_message — the SEND[200]
-- deliverable or the abandonment reason. Excludes this run's own loops.
SELECT l.run_id, r.name AS run_name, l.status, l.prompt, l.terminal_message
FROM loops l
JOIN runs r ON r.id = l.run_id
WHERE r.session_id = $session_id
  AND l.terminated_at IS NOT NULL
  AND l.terminated_at > $since
  AND l.run_id != $run_id
ORDER BY l.terminated_at;

-- PREP: engine_insert_loop_termination_delta
-- §run-scheme — materialize a sibling's loop-termination as a delta: a SEND from
-- run:///<name> carrying the terminal status + message (the deliverable). origin=plurnk,
-- source=the terminated run — uniform with the env-delta. Born OPEN for a 2xx deliverable
-- (a child's success must reach the parent open + awakening), folded otherwise.
INSERT INTO log_entries (
    run_id, loop_id, turn_id, sequence, origin, source,
    op, scheme, pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx, expanded
) VALUES (
    $run_id, $loop_id, $turn_id, $sequence, 'plurnk', $source,
    'SEND', 'run', $pathname, '', 'text/plain', $rx, 'text/markdown', $status,
    CASE WHEN $status >= 200 AND $status < 300 THEN 1 ELSE 0 END
);

-- PREP: engine_entry_tags
SELECT tag FROM entry_tags WHERE entry_id = $entry_id ORDER BY tag;

-- PREP: engine_child_runs_live
-- The run's LIVE child runs — latest loop non-terminal (100 pending / 102 processing / 202 parked).
-- Powers the Child Runs orienting section (§child-orientation): terse `* <status> run://<name>`
-- pointers so the model SEES what it holds live and reasons for itself (READ/KILL), never told to.
-- Empty → section omitted.
SELECT r.name, l.status
FROM runs r
JOIN loops l ON l.id = (SELECT id FROM loops WHERE run_id = r.id ORDER BY sequence DESC, id DESC LIMIT 1)
WHERE r.parent_run_id = $run_id AND l.status IN (100, 102, 202)
ORDER BY r.name;

-- PREP: engine_child_streams_open
-- The run's OPEN streams (subscriptions not yet closed) — their addressable coord. Powers the Child
-- Streams orienting section (§child-orientation): terse `* active <runtime>:///<coord>` pointers the
-- model OPENs/READs/KILLs. Empty → section omitted.
SELECT s.scheme, e.pathname
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
WHERE s.run_id = $run_id AND s.closed_at IS NULL
ORDER BY e.pathname;

-- PREP: engine_render_telemetry_errors
-- SPEC §telemetry: 4xx/5xx log rows are mirrored into the packet's telemetry as
-- LogCoordinate pointers, forcing the model to confront failures instead of letting
-- them rot in log:///. Window = the current turn AND the immediately-prior one
-- (>= current_turn_seq - 1): prior-turn for action failures the model just caused,
-- current-turn so a same-turn engine error (the grinder's budget-overflow row, minted
-- pre-generate then re-derived) surfaces THIS turn rather than a turn late.
-- §telemetry-uniform-error-channel
SELECT
    le.op, le.sequence, le.status_rx, le.rx, le.mimetype_rx,
    le.scheme, le.pathname,
    t.sequence AS turn_seq, l.sequence AS loop_seq
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
WHERE le.loop_id = $loop_id
  AND le.status_rx >= 400
  -- §log-row-self-explains: every >=400 row points at ITSELF — the op row carries its failure
  -- message on its meta line (packet-wire), so the pointer leads to a record that states its why.
  AND t.sequence >= $current_turn_seq - 1
ORDER BY t.sequence, le.sequence;

-- PREP: engine_grinder_fold_newest_turn
-- §grinder-layer1-rollback — THE DOCTRINE: the log is the model's memory and the model ALONE
-- curates it (FOLD/KILL). The grinder never touches history — it only blocks NEW memories from
-- landing when there is no room: one set-op folds the still-open rows of the newest turn
-- boundary — the immediately-prior turn's emissions and the current turn's pre-model rows
-- (foists, wake surfaces). Turn 1 is the same rule (no prior turn; its foists are the newest).
-- Folded, never deleted; op='error' rows are EXEMPT (§grinder-errors-exempt), and so is the
-- user PROMPT (#382 — the task frame the engine foisted is not the model's curatable memory;
-- the engine never reclaims the definition of the task it set).
UPDATE log_entries SET expanded = 0
WHERE loop_id = $loop_id AND expanded = 1 AND op != 'error'
  AND NOT (COALESCE(scheme, '') = 'plurnk' AND COALESCE(pathname, '') LIKE '/prompt/%')  -- NULL-safe: a model row's scheme is NULL
  AND (turn_id = $turn_id
       OR turn_id = (SELECT MAX(id) FROM turns WHERE loop_id = $loop_id AND id < $turn_id));

-- PREP: engine_fold_log_entry
-- §prompt-fold (User Note 6): fold a single log row by id — collapse to its
-- coordinate, body elided in the render, re-OPENable. Used for the foisted prompt
-- EDIT, which duplicates packet.user.prompt: logged for forensics, born folded.
UPDATE log_entries SET expanded = 0 WHERE id = $id;

-- PREP: engine_render_log
-- Render-time log assembly (SPEC §packet packet.system.log).
-- Yields log_entries for the whole RUN — the conversation's working
-- memory carries across loops within a session's run, not just the
-- current loop. Coordinate is log:///<loop_seq>/<turn_seq>/<sequence>/<op>.
-- Status 202 entries in state='proposed' are model-invisible until resolved.
-- `expanded = 0` rows are FOLDED — listed but collapsed to their coordinate
-- (FOLD); the renderer elides the body. §open-fold: folded rows stay listed, re-OPENable.
SELECT
    l.sequence  AS loop_seq,
    t.sequence  AS turn_seq,
    le.sequence,
    -- le.origin is attribution, never a render filter; the run's actor — §actor-boundary-origin-not-filter §machine-processes-run-origin
    le.origin,
    le.op, le.suffix, le.signal,
    le.scheme, le.username, le.password,
    le.hostname, le.port, le.pathname,
    le.params, le.fragment,
    le.status_rx, le.rx, le.mimetype_rx,
    le.tx, le.mimetype_tx,
    le.state, le.outcome, le.expanded, le.source, le.attrs
FROM log_entries le
JOIN turns t ON t.id = le.turn_id
JOIN loops l ON l.id = le.loop_id
-- WHERE renders exactly one run's log — §actor-boundary-isolation §machine-processes-run-is-its-log
-- the AND NOT clauses keep proposed (202) rows hidden until resolved (§proposal-proposed-hidden),
-- and SUCCESSFUL OPEN/FOLD render-directive rows out of the packet (#382 — recorded in the DB for
-- forensics, suppressed from materialization so a curation receipt rents zero packet space; the
-- successful fold that hid the task frame in run43 left NO trace, the database dig. A FAILED
-- OPEN/FOLD still renders — errors are signals, §telemetry-uniform-error-channel).
WHERE le.run_id = $run_id
  AND NOT (le.status_rx = 202 AND le.state = 'proposed')
  AND NOT (le.op IN ('OPEN', 'FOLD') AND le.status_rx < 400)
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: engine_insert_log_entry
-- Default state='resolved' covers the common path (non-proposing schemes
-- return their final status immediately). Status 202 + state='proposed'
-- triggers the proposal lifecycle (engine pauses dispatch; client resolves
-- via loop/resolve RPC; entry transitions through engine_resolve_log_entry).
INSERT INTO log_entries (
    run_id, loop_id, turn_id, sequence, origin, source,
    op, suffix, signal,
    scheme, username, password, hostname, port,
    pathname, params, fragment, lineMarker,
    tx, mimetype_tx, rx, mimetype_rx, status_rx, tokens,
    state, outcome, attrs
) VALUES (
    $run_id, $loop_id, $turn_id, $sequence, $origin, $source,
    $op, $suffix, $signal,
    $scheme, $username, $password, $hostname, $port,
    $pathname, $params, $fragment, $lineMarker,
    $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $tokens,
    $state, $outcome, $attrs
)
RETURNING id;

-- PREP: engine_resolve_log_entry
-- Transitions a proposed log entry to its terminal state. Used by the
-- proposal lifecycle (loop/resolve RPC, YOLO auto-accept, timeout, abort).
-- Updates status_rx + rx + state + outcome atomically.
UPDATE log_entries
   SET state = $state,
       outcome = $outcome,
       status_rx = $status_rx,
       rx = $rx
 WHERE id = $id
   AND state = 'proposed';

-- PREP: engine_turn_retrievals
-- §send-premature-terminate — the pending set's retrieval leg: THIS turn's READ/FIND/OPEN rows,
-- whose results the model cannot have seen (they fold back next packet). A [200] over them is
-- discarding answers it asked for.
SELECT id FROM log_entries
WHERE turn_id = $turn_id AND origin = 'model' AND op IN ('READ', 'FIND', 'OPEN');

-- PREP: engine_turn_failures
-- §send-200-failed-ops — THIS turn's failed op results (the model's own ops, status >= 400), whose
-- errors the model cannot have seen (they land next packet). A [200] over them concludes blind
-- past a failure — refused 409; [499] abandons regardless (declaring failure IS weighing it).
-- op='error' rows are EXCLUDED: the error CHANNEL is already-surfaced signal (the grinder's
-- overflow row mints pre-packet — the recovery turn SAW it; §grinder-hard-413-recovery's
-- concluding-is-legitimate stands), and the current emission's parse errors ride the threaded
-- count instead (they mint as rows only after dispatch).
SELECT id FROM log_entries
WHERE turn_id = $turn_id AND origin = 'model' AND status_rx >= 400 AND op != 'error';

-- PREP: engine_demote_turn_status
-- §send-premature-terminate — a terminal REFUSED at dispatch (the pending-set 409) demotes the
-- turn to a continue AFTER the close already persisted the provisional status (the close writes
-- packet+usage as soon as the model responds; ops dispatch after). The record must match the
-- truth the return value carries: the loop never went terminal, so the turn didn't either.
UPDATE turns SET status = $status WHERE id = $id;

-- PREP: token_count_get
-- #312 — the keyed token-derivation lookup: one content blob, one tokenizer identity, one count.
SELECT tokens FROM token_counts WHERE content_hash = $content_hash AND tokenizer_id = $tokenizer_id;

-- PREP: token_count_upsert
INSERT INTO token_counts (content_hash, tokenizer_id, tokens) VALUES ($content_hash, $tokenizer_id, $tokens)
ON CONFLICT (content_hash, tokenizer_id) DO UPDATE SET tokens = excluded.tokens;

-- PREP: token_stale_channels
-- #312 — the pump's recount worklist: body channels whose (content_hash, active tokenizer) pair
-- has no derivation row yet. A model swap to a NEW tokenizer identity makes every row miss (the
-- bulk recount); a swap between vocab-sharing models misses nothing.
SELECT ec.entry_id, ec.content, ec.content_hash
FROM entry_channels ec
JOIN entries e ON e.id = ec.entry_id
WHERE e.session_id = $session_id AND ec.name = 'body' AND ec.content_hash IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM token_counts tc WHERE tc.content_hash = ec.content_hash AND tc.tokenizer_id = $tokenizer_id);


-- PREP: engine_loop_sequence
-- The loop's PER-RUN sequence — the model-facing coordinate (prompt/<loop-seq>/<turn-seq>,
-- matching the log's loop-relative numbering). The raw db id leaked into prompt paths and the
-- model's first loop read as prompt/2/1 (the docs loop holds id 1). Owner: minor but annoying.
SELECT sequence FROM loops WHERE id = $loop_id;
