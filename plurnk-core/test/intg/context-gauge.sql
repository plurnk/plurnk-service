-- PREP: test_context_insert_turn
INSERT INTO turns (
    loop_id,
    sequence,
    status,
    packet,
    usage_prompt,
    usage_prompt_budget
)
VALUES (
    $loop_id,
    $sequence,
    200,
    '{}',
    $prompt,
    $prompt_budget
)
RETURNING id;

-- PREP: test_context_insert_attempt
INSERT INTO turn_attempts (
    turn_id,
    sequence,
    accepted,
    response,
    parse_errors,
    usage_prompt,
    model
)
VALUES (
    $turn_id,
    1,
    1,
    '{"assistant":{"content":"fixture"}}',
    '[]',
    $prompt,
    'fixture'
);
