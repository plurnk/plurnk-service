-- PREP: test_context_insert_turn
INSERT INTO turns (
    loop_id,
    sequence,
    status,
    packet,
    usage_prompt_budget
)
VALUES (
    $loop_id,
    $sequence,
    200,
    '{"tokens":0,"sections":[],"attributions":[],"assistant":{"content":"fixture","ops":[],"reasoning":null},"assistantRaw":null}',
    $prompt_budget
)
RETURNING id;

-- PREP: test_context_insert_model_call
INSERT INTO model_calls (
    turn_id,
    sequence,
    kind,
    state,
    response,
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
