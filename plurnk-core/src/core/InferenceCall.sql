-- InferenceCall: the physical provider request beneath a model call.

-- PREP: engine_open_provider_request
-- The provider calls this immediately before physical I/O.
INSERT INTO provider_requests (inference_call_id, sequence, provider, model)
VALUES ($inference_call_id, $sequence, $provider, $model)
RETURNING id;

-- PREP: engine_settle_provider_request
UPDATE provider_requests SET
    state = 'settled',
    outcome = $outcome,
    status = $status,
    usage_input = $usage_input,
    usage_output = $usage_output,
    usage_total = $usage_total,
    usage_input_no_cache = $usage_input_no_cache,
    usage_input_cache_read = $usage_input_cache_read,
    usage_input_cache_write = $usage_input_cache_write,
    usage_output_text = $usage_output_text,
    usage_output_reasoning = $usage_output_reasoning,
    cost_kind = $cost_kind,
    cost_amount = $cost_amount,
    cost_currency = $cost_currency,
    cost_usd_equivalent = $cost_usd_equivalent,
    cost_source = $cost_source,
    cost_reason = $cost_reason,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = $id AND state = 'pending';
