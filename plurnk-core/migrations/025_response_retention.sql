-- MIGRATE: 25 response retention
-- Released in 3.2.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§retention-policy}: one logical call owns retirement of all its captured payloads.
ALTER TABLE inference_calls ADD COLUMN payloads_retired_at TEXT;

CREATE TRIGGER inference_payload_retirement_insert
BEFORE INSERT ON inference_calls WHEN NEW.payloads_retired_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'inference payloads cannot open retired');
END;

CREATE TRIGGER inference_payload_retirement_once
BEFORE UPDATE OF payloads_retired_at ON inference_calls
WHEN OLD.payloads_retired_at IS NOT NULL OR NEW.payloads_retired_at IS NULL
  OR NEW.state = 'pending'
  OR NOT EXISTS (SELECT 1 FROM turns WHERE id = NEW.turn_id AND completed_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM provider_requests WHERE inference_call_id = NEW.id AND state = 'pending')
BEGIN
    SELECT RAISE(ABORT, 'inference payload retirement requires completed work and occurs once');
END;

CREATE TRIGGER provider_request_payload_immutable
BEFORE UPDATE OF evidence ON provider_requests
WHEN OLD.state <> 'pending' AND NOT (
    OLD.evidence IS NOT NULL AND NEW.evidence IS NULL
    AND EXISTS (SELECT 1 FROM inference_calls WHERE id = OLD.inference_call_id AND payloads_retired_at IS NOT NULL)
)
BEGIN
    SELECT RAISE(ABORT, 'provider request payload is immutable except through retention');
END;
