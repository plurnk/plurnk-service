-- PREP: test_context_insert_turn
INSERT INTO turns (
    loop_id,
    sequence,
    producer,
    kind,
    status,
    packet,
    usage_curation_budget
)
VALUES (
    $loop_id,
    $sequence,
    'model',
    'inference',
    200,
    json_object(
        'weight', CAST($curation_weight AS INTEGER),
        'sections', json('[]'),
        'attributions', json('[]'),
        'assistant', json('{"content":"fixture","ops":[],"reasoning":null}'),
        'assistantRaw', json('null')
    ),
    $curation_budget
)
RETURNING id;

-- PREP: test_context_insert_failed_model_call
INSERT INTO inference_calls (workspace_id, turn_id, sequence, kind, request_model)
SELECT w.workspace_id, $turn_id, $sequence, 'emission', 'fixture'
FROM turns t
JOIN loops l ON l.id = t.loop_id
JOIN workers w ON w.id = l.worker_id
WHERE t.id = $turn_id
RETURNING id;

-- PREP: test_context_fail_model_call
UPDATE model_calls
SET failure = json('{"status":413,"problem":{"type":"https://problems.plurnk.xyz/provider/fixture/capacity-exceeded","title":"Capacity exceeded","status":413,"detail":"Fixture capacity failure."}}'),
    capacity = $capacity
WHERE id = $id;

-- PREP: test_context_insert_model_call
INSERT INTO inference_calls (workspace_id, turn_id, sequence, kind, request_model)
SELECT w.workspace_id, $turn_id, $sequence, $kind, 'fixture'
FROM turns t
JOIN loops l ON l.id = t.loop_id
JOIN workers w ON w.id = l.worker_id
WHERE t.id = $turn_id
RETURNING id;

-- PREP: test_context_close_model_call
UPDATE model_calls
SET response = '{"assistant":{"content":"fixture"}}',
    capacity = $capacity,
    finish_reason = 'stop',
    response_model = 'fixture'
WHERE id = $id;

-- PREP: test_context_insert_attempt
INSERT INTO turn_attempts (model_call_id, accepted)
VALUES ($model_call_id, 1)
RETURNING id;

-- PREP: test_context_insert_request
INSERT INTO provider_requests (
    inference_call_id, sequence, provider, model, state, outcome,
    usage_input, usage_output, usage_total,
    cost_kind, cost_amount, cost_currency, cost_source, completed_at
)
VALUES (
    $model_call_id, 1, 'provider:fixture', 'fixture', 'settled', 'response',
    $input, 0, $input,
    'estimated', '0', 'USD', 'context gauge fixture',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
