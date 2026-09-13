-- TurnMaterialization: the harness rows a turn opens with — stream deltas the worker observes.

-- PREP: engine_worker_stream_channels
-- {§exec-stream} — every not-yet-terminally-published stream channel the worker
-- owns, with its durable per-subscription cursor. Log curation never rewinds it.
SELECT s.id AS subscription_id, sp.id AS publication_id,
    sp.published_end, sp.terminal_published,
    e.scheme AS runtime, e.authority, e.pathname AS coord,
    ec.name AS channel, ec.content AS content, ec.mimetype AS mimetype,
    ec.state AS state, ec.producer_result AS producer_result,
    s.published_channel, s.source, e.default_channel
FROM subscriptions s
JOIN entries e ON e.id = s.entry_id
JOIN subscription_publications sp ON sp.subscription_id = s.id
JOIN entry_channels ec ON ec.entry_id = s.entry_id AND ec.name = sp.channel
WHERE s.worker_id = $worker_id
  AND sp.terminal_published = 0
ORDER BY s.id, ec.name;

-- PREP: engine_mark_publication_terminal
-- {§exec-stream} — an empty sibling channel of a concluded stream lands no row of its own; its
-- publication is still marked terminal here so the stream's termination counts as delivered.
UPDATE subscription_publications
SET published_end = $published_end,
    terminal_published = 1,
    version = version + 1
WHERE id = $publication_id
  AND terminal_published = 0;

-- PREP: engine_insert_stream_delta
-- {§exec-stream} / {§env-delta} — materialize a channel's next publishable content as a
-- foisted READ row (the model READs the stream it never typed). origin=_plurnk; fragment is
-- the channel; source links an EXEC observation to its causal invocation;
-- attrs.streamEnd is the next turn's cursor. Only terminal observations
-- materialize here, initially visible; active progress stays in the Delegation streams list. {§exec-stream}
INSERT INTO log_entries (
    worker_id, loop_id, turn_id, sequence, origin, source, model_call_id,
    subscription_publication_id,
    op, scheme, hostname, port, pathname, fragment, tx, mimetype_tx, rx, mimetype_rx, status_rx, weight, attrs, initial_folded
) VALUES (
    $worker_id, $loop_id, $turn_id, $sequence, '_plurnk', $source, NULL,
    $subscription_publication_id,
    'READ', $scheme, $hostname, $port, $pathname, $fragment, '', 'text/plain', $rx, 'application/json', $status, $weight, $attrs, $folded
);
