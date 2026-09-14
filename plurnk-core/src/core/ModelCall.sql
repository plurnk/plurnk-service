-- ModelCall: the logical model call beneath a turn attempt, and its closing triggers.

-- PREP: engine_open_model_call
-- Logical identity and request attribution become durable before provider I/O.
INSERT INTO inference_calls (
    workspace_id, turn_id, sequence, kind, attributions, request_model
)
SELECT
    w.workspace_id,
    t.id,
    COALESCE((SELECT MAX(sequence) FROM inference_calls WHERE turn_id = $turn_id), 0) + 1,
    $kind,
    $attributions,
    $model
FROM turns t
JOIN loops l ON l.id = t.loop_id
JOIN workers w ON w.id = l.worker_id
WHERE t.id = $turn_id
RETURNING id, sequence;

-- PREP: engine_observe_model_call_response
-- Preserve the logical response before call-specific interpretation. Physical
-- request accounting has already settled through its cardinal observer path.
-- The observation view records the evidence, the body and the close together;
-- a settled call refuses it.
INSERT INTO model_call_observation (id, native_inputs, response, failure, capacity, finish_reason, response_model)
VALUES ($id, $native_inputs, $response, $failure, $capacity, $finish_reason, $model);

-- PREP: engine_fail_model_call
-- A failure-only observation closes the call as an error.
INSERT INTO model_call_observation (id, failure, capacity)
VALUES ($id, $failure, $capacity);

-- INIT: inference_calls_create_model_specialization
DROP TRIGGER IF EXISTS inference_calls_create_model_specialization;
CREATE TRIGGER inference_calls_create_model_specialization
AFTER INSERT ON inference_calls
WHEN NEW.kind IN ('emission', 'bare')
BEGIN
    INSERT INTO model_calls (id) VALUES (NEW.id);
END;
