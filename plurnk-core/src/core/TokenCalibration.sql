-- TokenCalibration: measured weight against reported tokens, per model, one factor per loop.

-- PREP: engine_calibration_loop_sample
-- {§tokenomics-calibrated-readout} — the sample that fixes a loop's factor: its first settled emission
-- response from the model, pairing the request's measured packet weight with the provider's reported
-- prompt count. Only rows where both figures are positive.
SELECT json_extract(t.packet, '$.weight') AS weight, pr.usage_input AS reported
FROM turns t
JOIN inference_calls ic ON ic.turn_id = t.id
JOIN provider_requests pr ON pr.inference_call_id = ic.id
WHERE t.loop_id = $loop_id AND pr.model = $model AND pr.state = 'settled' AND pr.outcome = 'response'
  AND ic.kind = 'emission' AND pr.usage_input > 0
  AND t.packet IS NOT NULL AND json_extract(t.packet, '$.weight') > 0
ORDER BY pr.id ASC
LIMIT 1;

-- PREP: engine_calibration_model_sample
-- {§tokenomics-calibrated-readout} — the model's most recently fixed factor, for a loop that has not fixed
-- its own: the newest sample that is the first of its loop, from any loop or worker.
SELECT json_extract(t.packet, '$.weight') AS weight, pr.usage_input AS reported
FROM provider_requests pr
JOIN inference_calls ic ON ic.id = pr.inference_call_id
JOIN turns t ON t.id = ic.turn_id
WHERE pr.model = $model AND pr.state = 'settled' AND pr.outcome = 'response'
  AND ic.kind = 'emission' AND pr.usage_input > 0
  AND t.packet IS NOT NULL AND json_extract(t.packet, '$.weight') > 0
  AND NOT EXISTS (
      SELECT 1
      FROM turns earlier_turn
      JOIN inference_calls earlier_call ON earlier_call.turn_id = earlier_turn.id
      JOIN provider_requests earlier ON earlier.inference_call_id = earlier_call.id
      WHERE earlier_turn.loop_id = t.loop_id AND earlier.id < pr.id AND earlier.model = $model
        AND earlier.state = 'settled' AND earlier.outcome = 'response'
        AND earlier_call.kind = 'emission' AND earlier.usage_input > 0
        AND earlier_turn.packet IS NOT NULL AND json_extract(earlier_turn.packet, '$.weight') > 0
  )
ORDER BY pr.id DESC
LIMIT 1;
