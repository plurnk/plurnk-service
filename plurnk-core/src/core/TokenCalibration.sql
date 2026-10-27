-- TokenCalibration: measured weight against reported tokens, per model.

-- PREP: engine_calibration_loop_sample
-- {§tokenomics} — the loop's latest settled emission response from the model,
-- pairing the request's measured packet weight with the provider's reported prompt count. Only rows
-- where both figures are positive.
SELECT json_extract(t.packet, '$.weight') AS weight, pr.usage_input AS reported
FROM turns t
JOIN inference_calls ic ON ic.turn_id = t.id
JOIN provider_requests pr ON pr.inference_call_id = ic.id
WHERE t.loop_id = $loop_id AND pr.model = $model AND pr.state = 'settled' AND pr.outcome = 'response'
  AND ic.kind = 'emission' AND pr.usage_input > 0
  AND t.packet IS NOT NULL AND json_extract(t.packet, '$.weight') > 0
ORDER BY pr.id DESC
LIMIT 1;

-- PREP: engine_calibration_model_sample
-- {§tokenomics} — the model's latest settled emission response across any loop
-- or session, for a loop that has not settled one of its own.
SELECT json_extract(t.packet, '$.weight') AS weight, pr.usage_input AS reported
FROM provider_requests pr
JOIN inference_calls ic ON ic.id = pr.inference_call_id
JOIN turns t ON t.id = ic.turn_id
WHERE pr.model = $model AND pr.state = 'settled' AND pr.outcome = 'response'
  AND ic.kind = 'emission' AND pr.usage_input > 0
  AND t.packet IS NOT NULL AND json_extract(t.packet, '$.weight') > 0
ORDER BY pr.id DESC
LIMIT 1;
