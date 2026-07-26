-- Engine SQL. SPEC §arch (architecture), §scheme (op dispatch + log).

-- PREP: engine_loop_status
SELECT status FROM loops WHERE id = $loop_id;

-- PREP: engine_worker_has_live_child
-- A non-terminal CHILD run (worker:// spawn/fork set parent_worker_id) — a "live thing the worker holds",
-- like an open stream. A SEND[200] while one exists is a premature-terminate (§send-premature-terminate).
-- Live = a child whose LATEST loop is still pending/running/parked (100/102/202) — the SAME definition
-- engine_child_workers_live uses for the Child Runs orientation, so the 409 gate and the section the model
-- reads NEVER disagree: a refused termination is always backed by a child the model can SEE and KILL
-- (§child-orientation). An inherited/historical loop (a fork copies the parent's loops) is not the
-- latest, so it never makes a concluded child look forever-live.
SELECT 1 AS live FROM workers r
JOIN loops l ON l.id = (SELECT id FROM loops WHERE worker_id = r.id ORDER BY sequence DESC, id DESC LIMIT 1)
WHERE r.parent_worker_id = $worker_id AND l.status IN (100, 102, 202) LIMIT 1;

-- PREP: engine_count_active_loops_for_worker
-- Wake-on-completion uses this to decide whether to open a new loop or
-- let the existing one pick up the channel transition at the next turn
-- boundary. Status 102 = "in progress" (any non-terminal state).
SELECT COUNT(*) AS n FROM loops WHERE worker_id = $worker_id AND status = 102;

-- PREP: engine_get_loop_flags
-- Loads the loop's persisted flags (json). Default '{}'; auto listener and
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
-- system-origin EDIT against plurnk://prompt/<run>/<loop>/1 (§packet), at the
-- turn's first action sequence. Prompts are first-class log entries
-- (no synthetic / shim layer).
SELECT prompt, sequence FROM loops WHERE id = $loop_id;

-- PREP: engine_reclaim_queued_loop
-- §worker-lifecycle-wake-requeue-not-terminal — atomic 100→102 re-claim by loop id. A wake
-- re-queued this loop while ITS OWN live drain was between turns; the drain re-claims and
-- keeps running (the injected prompt is already the next turn). Conditional so a racing
-- claimant can never double-claim.
UPDATE loops SET status = 102 WHERE id = $loop_id AND status = 100;

-- PREP: workspace_get_settings
-- #231 — the workspace's client-chosen open-context bag ({ manifestItems?, mdDocs? }),
-- read at turn-0 with precedence over env.
SELECT settings FROM workspaces WHERE id = $workspace_id;

-- PREP: engine_target_diverged_this_turn
-- #note10 — did this entry diverge on disk THIS turn? A source=file env-delta for the
-- target, materialized into this worker's log at the current turn, means the model's view
-- predates the ambient change — a auto resolution of a same-turn EDIT would clobber it.
SELECT 1 AS hit
FROM log_entries
WHERE worker_id = $worker_id AND turn_id = $turn_id
  AND origin = 'plurnk' AND source = 'file' AND op = 'EDIT'
  AND scheme IS $scheme AND pathname = $pathname
LIMIT 1;

-- PREP: engine_list_workspace_entry_tags
-- #note13 — every (entry, tag) in the workspace, for the manifest catalog's tags field.
SELECT et.entry_id, et.tag
FROM entry_tags et
JOIN entries e ON e.id = et.entry_id
WHERE e.workspace_id = $workspace_id
ORDER BY et.entry_id, et.tag;

-- PREP: engine_list_worker_entries
-- {§entry-owner} — one principal's entries (catalogRowsFor source for an owner-scoped FIND/foist):
-- the commons, a worker's own space, or a named space — exactly one owner's rows, its perspective.
SELECT e.id AS entry_id, e.scheme, e.pathname, ec.name AS channel, ec.content, ec.mimetype, ec.tokens AS tokens, e.deep_hash,
    CAST(unixepoch('now') - unixepoch(s.opened_at) AS INTEGER) AS seconds
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
LEFT JOIN subscriptions s ON s.entry_id = e.id AND s.closed_at IS NULL
WHERE e.workspace_id = $workspace_id AND e.owner_id = $owner_id
ORDER BY e.updated_at ASC, e.id ASC, ec.name;

-- PREP: engine_list_worker_entry_tags
-- {§entry-owner} — (entry, tag) for one principal's entries (the owner-scoped catalog's tags field).
SELECT et.entry_id, et.tag
FROM entry_tags et
JOIN entries e ON e.id = et.entry_id
WHERE e.workspace_id = $workspace_id AND e.owner_id = $owner_id
ORDER BY et.entry_id, et.tag;

-- PREP: engine_worker_scratch_count
-- §worker-scheme — distinct entry count owned by the building worker, to decide whether the
-- turn-0 catalog foists a FIND(worker://~/**) (a worker with no private space foists nothing).
SELECT COUNT(DISTINCT e.id) AS entries
FROM entries e
WHERE e.workspace_id = $workspace_id AND e.owner_id = $owner_id;

-- PREP: engine_next_turn_sequence
SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = $loop_id;

-- PREP: engine_loop_usage
-- Per-loop usage totals — SUM the loop's turns (§tokenomics stores usage per turn).
-- Surfaced on loop.run + loop/terminated (#197). `context` is the LAST turn's prompt tokens — the
-- honest window-occupancy numerator (#263), distinct from the summed `prompt` (which overcounts a
-- context that grows across turns).
SELECT COALESCE(SUM(usage_prompt), 0)     AS prompt,
       COALESCE(SUM(usage_completion), 0) AS completion,
       COALESCE(SUM(usage_cost_usd), 0)  AS cost_usd,
       (SELECT usage_prompt FROM turns WHERE loop_id = $loop_id ORDER BY sequence DESC LIMIT 1) AS context,
       -- #274 — the LAST turn's model window (denominator), so numerator + denominator come from
       -- the same loop/model; NULL when the provider reports no window.
       (SELECT usage_prompt_budget FROM turns WHERE loop_id = $loop_id ORDER BY sequence DESC LIMIT 1) AS context_size,
       -- #252 — the opaque provider meta blob from the LATEST turn (for example, a
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
    usage_cost_usd = $usage_cost_usd,
    usage_prompt_budget = $usage_prompt_budget,
    finish_reason = $finish_reason,
    model = $model,
    meta = $meta
WHERE id = $id;

-- PREP: engine_list_workspace_entries
-- Every entry of a workspace — all schemes, all channels — the source behind the entry
-- catalog (catalogRowsFor / FIND) and the per-turn derivation pump (maintainDerivations).
-- Workspace-scoped (persists across runs); FOLD doesn't drop from the catalog.
-- `seconds` is the live age of an active stream: now − the open subscription's
-- opened_at (closed_at IS NULL). NULL for static entries. unixepoch parses the
-- stored '...%fZ' timestamp directly; re-evaluated every render like tokens.
SELECT e.id AS entry_id, e.scheme, e.pathname, ec.name AS channel, ec.content, ec.mimetype, ec.tokens AS tokens, e.deep_hash,
    CAST(unixepoch('now') - unixepoch(s.opened_at) AS INTEGER) AS seconds
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
LEFT JOIN subscriptions s ON s.entry_id = e.id AND s.closed_at IS NULL
-- entries are workspace-scoped, shared across runs — §machine-processes-one-filesystem
WHERE e.workspace_id = $workspace_id
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
WHERE e.workspace_id = $workspace_id
GROUP BY e.scheme
ORDER BY e.scheme;

-- PREP: engine_worker_prior_turn_time
-- §env-delta — timestamp of this worker's most recent turn BEFORE the current one
-- (the "since I last looked" boundary). NULL on the worker's first turn → no deltas.
SELECT MAX(t.timestamp) AS since
FROM turns t JOIN loops l ON l.id = t.loop_id
WHERE l.worker_id = $worker_id AND t.id != $turn_id;

-- PREP: engine_pull_env_deltas
-- §env-delta — other actors' resolved EDITs on shared entries since this worker last
-- looked. Real edits (origin model/client) AND the plurnk worker's fs-sync fictions
-- (origin=plurnk on the reserved 'plurnk' run); excludes this worker's own rows and
-- other workers' already-materialized deltas (origin=plurnk on a real run). plurnk:///
-- entries (manifest/prompt/doc) never surface. This is the environment door (§actor-boundary-two-doors); the voice door is inject.
SELECT le.worker_id, le.scheme, le.pathname, le.rx, le.source, le.attrs
FROM log_entries le
JOIN workers r ON r.id = le.worker_id
WHERE r.workspace_id = $workspace_id
  AND le.op = 'EDIT'
  AND le.state = 'resolved'
  AND le.status_rx IN (200, 201)
  AND (le.scheme IS NULL OR le.scheme != 'plurnk')
  AND le.worker_id != $worker_id
  AND le.at > $since
  AND (le.origin != 'plurnk'
       OR le.worker_id = (SELECT id FROM workers WHERE workspace_id = $workspace_id AND name = 'plurnk'))
ORDER BY le.at;

-- PREP: engine_insert_env_delta
-- §env-delta — materialize a pulled cross-actor edit as a FOLDED delta (expanded=0)
-- in this worker's log. origin=plurnk; source carries the cause (sibling worker id or
-- 'file'); rx reuses the originating row's result span (§edit-result-render).
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source,
    op, scheme, pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx, expanded, attrs
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, 'plurnk', $source,
    'EDIT', $scheme, $pathname, '', 'text/plain', $rx, 'application/json', 200, 0, $attrs
);

-- PREP: engine_worker_stream_channels
-- §exec-stream — every stream channel the worker owns (an EXEC's stdout/stderr live on the
-- runtime-tag entry), with content + state + coordinate, so the per-turn injector can emit the
-- channel's unshown byte-delta. Stays listed until its last delta is shown (cursor == content len).
SELECT s.id AS subscription_id, e.scheme AS runtime, e.pathname AS coord,
    ec.name AS channel, ec.content AS content, ec.state AS state, s.close_status AS close_status,
    s.published_channel AS published_channel
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
JOIN entry_channels ec ON ec.entry_id = s.entry_id
WHERE s.worker_id = $worker_id
  AND (s.published_channel IS NULL OR ec.name = s.published_channel)
ORDER BY s.id, ec.name;

-- PREP: engine_stream_cursor
-- §exec-stream — bytes of this channel already shown to the worker: the streamEnd recorded on its
-- latest foisted delta (the caller defaults to 0 when none exists yet).
SELECT attrs
FROM log_entries
WHERE worker_id = $worker_id AND origin = 'plurnk' AND op = 'READ'
    AND scheme = $scheme AND pathname = $pathname AND fragment IS $fragment
ORDER BY id DESC LIMIT 1;

-- PREP: engine_insert_stream_delta
-- §exec-stream / §env-delta — materialize a channel's unshown byte-delta as a
-- foisted READ@200 row (the model READs the stream it never typed). origin=plurnk; fragment is
-- the channel; attrs.streamEnd is the next turn's cursor; expanded=1 when the channel has CLOSED
-- (the terminal delta auto-OPENs), 0 while it streams (ongoing deltas fold). §exec-stream
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source,
    op, scheme, pathname, fragment, tx, mimetype_tx, rx, mimetype_rx, status_rx, attrs, expanded
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, 'plurnk', NULL,
    'READ', $scheme, $pathname, $fragment, '', 'text/plain', $rx, 'application/json', 200, $attrs, $expanded
);

-- PREP: engine_pull_loop_terminations
-- §worker-scheme — sibling runs' loops that reached a terminal status since this worker last
-- looked (the loop-termination ambient delta). Carries terminal_message — the SEND[200]
-- deliverable or the abandonment reason — plus terminated_by so a cancellation renders
-- its marker (#379). Excludes this worker's own loops.
SELECT l.worker_id, r.name AS worker_name, l.status, l.prompt, l.terminal_message, l.terminated_by
FROM loops l
JOIN workers r ON r.id = l.worker_id
WHERE r.workspace_id = $workspace_id
  AND l.terminated_at IS NOT NULL
  AND l.terminated_at > $since
  AND l.worker_id != $worker_id
ORDER BY l.terminated_at;

-- PREP: engine_insert_loop_termination_delta
-- §worker-scheme — materialize a sibling's loop-termination as a delta: a SEND from
-- worker:///<name> carrying the terminal status + message (the deliverable). origin=plurnk,
-- source=the terminated run — uniform with the env-delta. Born OPEN for a 2xx deliverable
-- (a child's success must reach the parent open + awakening), folded otherwise.
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source,
    op, scheme, pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx, expanded
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, 'plurnk', $source,
    'SEND', 'worker', $pathname, '', 'text/plain', $rx, 'text/markdown', $status,
    CASE WHEN $status >= 200 AND $status < 300 THEN 1 ELSE 0 END
);

-- PREP: engine_entry_tags
SELECT tag FROM entry_tags WHERE entry_id = $entry_id ORDER BY tag;

-- PREP: engine_child_workers_live
-- The worker's LIVE child workers — latest loop non-terminal (100 pending / 102 processing / 202 parked).
-- Powers the Child Runs orienting section (§child-orientation): terse `* <status> worker://<name>`
-- pointers so the model SEES what it holds live and reasons for itself (READ/KILL), never told to.
-- Empty → section omitted.
SELECT r.name, l.status
FROM workers r
JOIN loops l ON l.id = (SELECT id FROM loops WHERE worker_id = r.id ORDER BY sequence DESC, id DESC LIMIT 1)
WHERE r.parent_worker_id = $worker_id AND l.status IN (100, 102, 202)
ORDER BY r.name;

-- PREP: engine_child_streams_open
-- The worker's OPEN streams (subscriptions not yet closed) — their addressable coord. Powers the Child
-- Streams orienting section (§child-orientation): terse `* active <runtime>:///<coord>` pointers the
-- model OPENs/READs/KILLs. Empty → section omitted.
SELECT s.scheme, e.pathname
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
WHERE s.worker_id = $worker_id AND s.closed_at IS NULL
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
-- Folded, never deleted; THREE exemptions (§grinder-errors-exempt): op='error' rows, the
-- user PROMPT (#382 — the task frame the engine foisted is not the model's curatable memory;
-- the engine never reclaims the definition of the task it set), and PLAN rows (#465, owner
-- ruling — the checklist is the model's orientation surface at exactly the moment the grinder
-- fires; plans are concise by rule, so exempting them reclaims almost nothing and preserves
-- the reasoning thread a recovery turn steers by).
UPDATE log_entries SET expanded = 0
WHERE loop_id = $loop_id AND expanded = 1 AND op NOT IN ('error', 'PLAN')
  AND COALESCE(scheme, '') != 'prompt'  -- the task frame ({§prompt-self-only}); NULL-safe: a model row's scheme is NULL
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
-- memory carries across loops within a workspace's run, not just the
-- current loop. Coordinate is log:///<loop_seq>/<turn_seq>/<sequence>/<op>.
-- Status 202 entries in state='proposed' are model-invisible until resolved.
-- `expanded = 0` rows are FOLDED — listed but collapsed to their coordinate
-- (FOLD); the renderer elides the body. §open-fold: folded rows stay listed, re-OPENable.
SELECT
    l.sequence  AS loop_seq,
    t.sequence  AS turn_seq,
    le.sequence,
    -- le.origin is attribution, never a render filter; the worker's actor — §actor-boundary-origin-not-filter §machine-processes-worker-origin
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
-- WHERE renders exactly one worker's log — §actor-boundary-isolation §machine-processes-worker-is-its-log
-- the AND NOT clauses keep proposed (202) rows hidden until resolved (§proposal-proposed-hidden),
-- and SUCCESSFUL log-curation receipts out of the packet (#382 — recorded in the DB for forensics,
-- suppressed from materialization so a curation act rents zero packet space; the successful fold
-- that hid the task frame in run43 left NO trace, the database dig). Two receipts, one principle:
--   OPEN/FOLD — render directives, always log-targeted, suppressed on success.
--   KILL of a LOG item — a real deletion whose tombstone is spent once executed; suppressed on
--   success too (run61: a floor model KILLed log rows ~2000×, and the tombstones — bodyless, but
--   ~130-char meta-lines apiece — became 95% of its packet, a self-growing curation trap). SCOPED
--   to le.scheme='log': a KILL of a worker:// note / sh:// stream is a world mutation, NOT log
--   housekeeping, and stays visible. A FAILED op of any kind still renders — errors are signals
--   (§telemetry-uniform-error-channel).
WHERE le.worker_id = $worker_id
  AND NOT (le.status_rx = 202 AND le.state = 'proposed')
  AND NOT (le.op IN ('OPEN', 'FOLD') AND le.status_rx < 400)
  AND NOT (le.op = 'KILL' AND le.scheme = 'log' AND le.status_rx < 400)
ORDER BY l.sequence, t.sequence, le.sequence;

-- PREP: engine_insert_log_entry
-- Default state='resolved' covers the common path (non-proposing schemes
-- return their final status immediately). Status 202 + state='proposed'
-- triggers the proposal lifecycle (engine pauses dispatch; client resolves
-- via loop/resolve RPC; entry transitions through engine_resolve_log_entry).
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source,
    op, suffix, signal,
    scheme, username, password, hostname, port,
    pathname, params, fragment, lineMarker,
    tx, mimetype_tx, rx, mimetype_rx, status_rx, tokens,
    state, outcome, attrs
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, $origin, $source,
    $op, $suffix, $signal,
    $scheme, $username, $password, $hostname, $port,
    $pathname, $params, $fragment, $lineMarker,
    $tx, $mimetype_tx, $rx, $mimetype_rx, $status_rx, $tokens,
    $state, $outcome, $attrs
)
RETURNING id;

-- PREP: engine_resolve_log_entry
-- Transitions a proposed log entry to its terminal state. Used by the
-- proposal lifecycle (loop/resolve RPC, auto resolution, timeout, abort).
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

-- PREP: engine_worker_has_undelivered_stream_term
-- A stream may finish between its EXEC and a same-turn SEND. It is then no longer
-- live, but its terminal outcome has not crossed the pre-turn observation boundary:
-- no foisted terminal READ exists yet. Treat that closed result like a same-turn
-- retrieval or child termination so an empty join cannot conclude over unseen work.
-- Completion is information independently of payload: an empty success and especially
-- an empty failure must receive the same terminal observation as a non-empty stream.
SELECT 1 AS pending
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
WHERE s.worker_id = $worker_id
  AND s.closed_at IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM log_entries le
      WHERE le.worker_id = $worker_id
        AND le.origin = 'plurnk'
        AND le.op = 'READ'
        AND le.scheme = e.scheme
        AND le.pathname = e.pathname
        AND json_extract(le.attrs, '$.terminal') = 1
  )
LIMIT 1;

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



-- PREP: engine_loop_sequence
-- The loop's PER-RUN sequence — the model-facing coordinate (prompt/<run>/<loop-seq>/<turn-seq>,
-- matching the log's loop-relative numbering). The raw db id leaked into prompt paths and the
-- model's first loop read as prompt/2/1 (the docs loop holds id 1). Owner: minor but annoying.
SELECT sequence FROM loops WHERE id = $loop_id;

-- PREP: engine_worker_lineage_root
-- #522 — the PRIMARY worker: the no-parent root the lineage descends from (walk parent_worker_id
-- up). A worker with no parent returns ITSELF (the primary's own turns stamp Worker-Primary ==
-- Worker-Id). The endpoint routes primary→strong, spawned→cheap by equality, so this is the
-- root-of-tree grouping key. Always resolvable (the chain is finite + acyclic — parent != id CHECK).
WITH RECURSIVE lineage(id, parent_worker_id) AS (
    SELECT id, parent_worker_id FROM workers WHERE id = $worker_id
    UNION ALL
    SELECT w.id, w.parent_worker_id FROM workers w JOIN lineage l ON w.id = l.parent_worker_id
)
SELECT id FROM lineage WHERE parent_worker_id IS NULL;

-- PREP: engine_worker_has_undelivered_child_term
-- A child worker whose loop TERMINATED after the current turn's timestamp — its deliverable
-- (the §worker-scheme collect delta) is queued for the NEXT packet build and has not been seen.
-- The 1ms-wide fan-out race: workers concluding DURING the parent's generation are not "live"
-- (the wait's J leg misses them) but their results are pending — concluding or ∅-collapsing
-- over them silently discards deliverables the model spawned. {§send-undelivered-child-term}
SELECT 1 AS pending FROM loops l
JOIN workers r ON r.id = l.worker_id
WHERE r.parent_worker_id = $worker_id
  AND l.terminated_at IS NOT NULL
  AND l.terminated_at > (SELECT timestamp FROM turns WHERE id = $turn_id)
LIMIT 1;
