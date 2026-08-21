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
INSERT INTO model_calls (
    turn_id,
    sequence,
    kind,
    state,
    failure,
    capacity,
    model,
    completed_at
)
VALUES (
    $turn_id,
    $sequence,
    'emission',
    'error',
    json('{"status":413,"problem":{"type":"https://problems.plurnk.dev/provider/fixture/capacity-exceeded","title":"Capacity exceeded","status":413,"detail":"Fixture capacity failure."}}'),
    $capacity,
    'fixture',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
RETURNING id;

-- PREP: test_context_insert_model_call
INSERT INTO model_calls (
    turn_id,
    sequence,
    kind,
    state,
    response,
    capacity,
    finish_reason,
    model,
    completed_at
)
VALUES (
    $turn_id,
    $sequence,
    $kind,
    'response',
    '{"assistant":{"content":"fixture"}}',
    $capacity,
    'stop',
    'fixture',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
RETURNING id;

-- PREP: test_context_insert_attempt
INSERT INTO turn_attempts (model_call_id, accepted)
VALUES ($model_call_id, 1)
RETURNING id;

-- PREP: test_context_insert_request
INSERT INTO provider_requests (
    model_call_id, sequence, provider, model, state, outcome,
    usage_input, usage_output, usage_total,
    cost_kind, cost_amount, cost_currency, cost_source, completed_at
)
VALUES (
    $model_call_id, 1, 'provider:fixture', 'fixture', 'settled', 'response',
    $input, 0, $input,
    'estimated', '0', 'USD', 'context gauge fixture',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
