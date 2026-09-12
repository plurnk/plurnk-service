-- TokenCalibration: measured weight against reported tokens, per model.

-- PREP: engine_calibration_samples
-- {§tokenomics-calibrated-readout} — one model's last five settled emission responses, each pairing
-- the request's measured packet weight with the provider's reported prompt count.
-- Newest first; only rows where both figures are positive.
SELECT json_extract(t.packet, '$.weight') AS weight, pr.usage_input AS reported
FROM provider_requests pr
JOIN inference_calls ic ON ic.id = pr.inference_call_id
JOIN turns t ON t.id = ic.turn_id
WHERE pr.model = $model AND pr.state = 'settled' AND pr.outcome = 'response'
  AND ic.kind = 'emission' AND pr.usage_input > 0
  AND t.packet IS NOT NULL AND json_extract(t.packet, '$.weight') > 0
ORDER BY pr.id DESC
LIMIT 5;
