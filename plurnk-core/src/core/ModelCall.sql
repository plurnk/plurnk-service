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
UPDATE model_calls SET
    native_inputs = $native_inputs,
    response = $response,
    failure = $failure,
    capacity = $capacity,
    finish_reason = $finish_reason,
    response_model = $model
WHERE id = $id
  AND (SELECT state FROM inference_calls WHERE id = model_calls.id) = 'pending';

-- PREP: engine_fail_model_call
UPDATE model_calls SET
    failure = $failure,
    capacity = $capacity
WHERE id = $id
  AND (SELECT state FROM inference_calls WHERE id = model_calls.id) = 'pending';

-- INIT: inference_calls_create_model_specialization
DROP TRIGGER IF EXISTS inference_calls_create_model_specialization;
CREATE TRIGGER inference_calls_create_model_specialization
AFTER INSERT ON inference_calls
WHEN NEW.kind IN ('emission', 'bare')
BEGIN
    INSERT INTO model_calls (id) VALUES (NEW.id);
END;

-- INIT: model_calls_close_response
DROP TRIGGER IF EXISTS model_calls_close_response;
CREATE TRIGGER model_calls_close_response
AFTER UPDATE OF response ON model_calls
WHEN NEW.response IS NOT NULL
BEGIN
    UPDATE inference_calls
    SET state = 'response', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.id AND state = 'pending';
END;

-- INIT: model_calls_close_error
DROP TRIGGER IF EXISTS model_calls_close_error;
CREATE TRIGGER model_calls_close_error
AFTER UPDATE OF failure ON model_calls
WHEN NEW.failure IS NOT NULL AND NEW.response IS NULL
BEGIN
    UPDATE inference_calls
    SET state = 'error', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.id AND state = 'pending';
END;
