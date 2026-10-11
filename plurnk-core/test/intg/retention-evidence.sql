-- PREP: test_retirement_state
SELECT id, payloads_retired_at FROM inference_calls WHERE id = $id;

-- PREP: test_retirement_rewrite
UPDATE inference_calls SET payloads_retired_at = $value WHERE id = $id;

-- PREP: test_request_payload_rewrite
UPDATE provider_requests SET evidence = $evidence WHERE id = $id;
