-- MIGRATE: 4 inference
-- Chapter 4 of the schema baseline ({§db-schema-baseline}): Inference: logical calls, model responses, emission attempts, physical provider requests.
-- Version numbers order the chapters on a fresh database; they are not history. A shape
-- change edits the chapter in place; existing development databases are recreated.

-- One logical model call owns its lifecycle and physical-request ledger.
-- Response and admission evidence specialize this identity. {§tokenomics-provider-usage}
CREATE TABLE IF NOT EXISTS inference_calls (
    id               INTEGER NOT NULL PRIMARY KEY,
    workspace_id     INTEGER NOT NULL,
    turn_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL CHECK (sequence >= 1),
    kind             TEXT    NOT NULL CHECK (kind IN ('emission', 'bare')),
    state            TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'response', 'error')),
    -- Exact opaque tag set forwarded with generation calls.
    attributions     TEXT    NOT NULL DEFAULT '[]' CHECK (
        json_valid(attributions) AND json_type(attributions) = 'array'
    ),
    request_model    TEXT    NOT NULL CHECK (length(request_model) >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at     TEXT,
    CHECK (
        (state = 'pending' AND completed_at IS NULL)
        OR (state IN ('response', 'error') AND completed_at IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS inference_calls_turn_sequence
    ON inference_calls (turn_id, sequence);

CREATE INDEX IF NOT EXISTS inference_calls_workspace_id
    ON inference_calls (workspace_id, timestamp, id);

CREATE TRIGGER IF NOT EXISTS inference_calls_open_pending
BEFORE INSERT ON inference_calls
WHEN NEW.state != 'pending' OR NEW.completed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'inference call must open pending');
END;

CREATE TRIGGER IF NOT EXISTS inference_calls_context_valid
BEFORE INSERT ON inference_calls
WHEN COALESCE((
    SELECT w.workspace_id = NEW.workspace_id
        AND t.producer = 'model' AND t.kind = 'inference'
    FROM turns t
    JOIN loops l ON l.id = t.loop_id
    JOIN workers w ON w.id = l.worker_id
    WHERE t.id = NEW.turn_id
), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'inference call requires a valid owning workspace and causal context');
END;

CREATE TRIGGER IF NOT EXISTS inference_calls_request_identity_immutable
BEFORE UPDATE OF workspace_id, turn_id, sequence, kind, attributions, request_model, timestamp
ON inference_calls
BEGIN
    SELECT RAISE(ABORT, 'inference call request identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS inference_calls_state_forward_only
BEFORE UPDATE OF state ON inference_calls
WHEN NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'pending' AND NEW.state IN ('response', 'error'))
)
BEGIN
    SELECT RAISE(ABORT, 'inference call state may only close once');
END;

CREATE TRIGGER IF NOT EXISTS inference_calls_terminal_evidence_required
BEFORE UPDATE OF state ON inference_calls
WHEN NEW.state != OLD.state
 AND NOT (
    (NEW.state = 'response' AND EXISTS (
        SELECT 1 FROM model_calls WHERE id = NEW.id AND response IS NOT NULL
    ))
    OR
    (NEW.state = 'error' AND EXISTS (
        SELECT 1 FROM model_calls WHERE id = NEW.id AND failure IS NOT NULL
    ))
 )
BEGIN
    SELECT RAISE(ABORT, 'inference call terminal state requires specialization evidence');
END;

CREATE TRIGGER IF NOT EXISTS inference_calls_completion_immutable
BEFORE UPDATE OF completed_at ON inference_calls
WHEN OLD.state != 'pending'
BEGIN
    SELECT RAISE(ABORT, 'inference call completion is immutable');
END;

-- Generation-specific response/failure evidence. The request model and
-- lifecycle remain on inference_calls; response_model is provider evidence.
CREATE TABLE IF NOT EXISTS model_calls (
    id               INTEGER NOT NULL PRIMARY KEY,
    -- {§packet-attachment-parts}: exact model-facing log coordinates whose
    -- native bytes were present in this completed request. The ordinary READ
    -- result remains independently durable in the log.
    native_inputs    TEXT    NOT NULL DEFAULT '[]' CHECK (
        json_valid(native_inputs) AND json_type(native_inputs) = 'array'
    ),
    response         TEXT             CHECK (response IS NULL OR json_valid(response)),
    failure          TEXT             CHECK (failure IS NULL OR json_valid(failure)),
    capacity         TEXT             CHECK (
        capacity IS NULL OR (json_valid(capacity) AND json_type(capacity) = 'object')
    ),
    finish_reason    TEXT,
    response_model   TEXT             CHECK (response_model IS NULL OR length(response_model) >= 1),
    CHECK (response IS NULL OR (capacity IS NOT NULL AND response_model IS NOT NULL)),
    CHECK (json_array_length(native_inputs) = 0 OR response IS NOT NULL),
    FOREIGN KEY (id) REFERENCES inference_calls(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER IF NOT EXISTS model_calls_specializes_generation
BEFORE INSERT ON model_calls
WHEN COALESCE((
    SELECT kind IN ('emission', 'bare') FROM inference_calls WHERE id = NEW.id
), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'model call must specialize a generation inference');
END;

CREATE TRIGGER IF NOT EXISTS model_calls_cannot_orphan_inference
AFTER DELETE ON model_calls
WHEN EXISTS (SELECT 1 FROM inference_calls WHERE id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'model call specialization cannot be deleted independently');
END;

CREATE TRIGGER IF NOT EXISTS model_calls_observation_pending
BEFORE UPDATE OF native_inputs, response, failure, capacity, finish_reason, response_model
ON model_calls
WHEN COALESCE((SELECT state FROM inference_calls WHERE id = OLD.id), '') != 'pending'
BEGIN
    SELECT RAISE(ABORT, 'model call observation is immutable');
END;

-- Emission admission specializes one model call without re-owning its response,
-- provider identity, ordering, or accounting evidence.
CREATE TABLE IF NOT EXISTS turn_attempts (
    id               INTEGER NOT NULL PRIMARY KEY,
    model_call_id    INTEGER NOT NULL UNIQUE,
    accepted         INTEGER          CHECK (accepted IS NULL OR accepted IN (0, 1)),
    parse_errors     TEXT    NOT NULL DEFAULT '[]' CHECK (
        json_valid(parse_errors) AND json_type(parse_errors) = 'array'
    ),
    FOREIGN KEY (model_call_id) REFERENCES model_calls(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER IF NOT EXISTS turn_attempts_request_identity_immutable
BEFORE UPDATE OF model_call_id ON turn_attempts
BEGIN
    SELECT RAISE(ABORT, 'emission attempt identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_emission_call_only
BEFORE INSERT ON turn_attempts
WHEN COALESCE((SELECT kind = 'emission' FROM inference_calls WHERE id = NEW.model_call_id), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'turn attempt requires an emission model call');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_classification_after_response
BEFORE UPDATE OF accepted, parse_errors ON turn_attempts
WHEN COALESCE((SELECT state = 'response' FROM inference_calls WHERE id = OLD.model_call_id), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'emission classification requires model response evidence');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_classification_once
BEFORE UPDATE OF accepted, parse_errors
ON turn_attempts
WHEN OLD.accepted IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'emission attempt classification is immutable');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_one_accepted_insert
BEFORE INSERT ON turn_attempts
WHEN NEW.accepted = 1 AND EXISTS (
    SELECT 1
    FROM turn_attempts existing
    JOIN inference_calls old_call ON old_call.id = existing.model_call_id
    JOIN inference_calls new_call ON new_call.id = NEW.model_call_id
    WHERE old_call.turn_id = new_call.turn_id AND existing.accepted = 1
)
BEGIN
    SELECT RAISE(ABORT, 'one emission may be accepted per turn');
END;

CREATE TRIGGER IF NOT EXISTS turn_attempts_one_accepted_update
BEFORE UPDATE OF accepted ON turn_attempts
WHEN NEW.accepted = 1 AND EXISTS (
    SELECT 1
    FROM turn_attempts existing
    JOIN inference_calls old_call ON old_call.id = existing.model_call_id
    JOIN inference_calls new_call ON new_call.id = NEW.model_call_id
    WHERE old_call.turn_id = new_call.turn_id
      AND existing.id != OLD.id
      AND existing.accepted = 1
)
BEGIN
    SELECT RAISE(ABORT, 'one emission may be accepted per turn');
END;

-- {§provider-request-accounting}: one row is opened before one physical
-- provider request and settled exactly once with the evidence from that request.
-- Monetary values remain canonical decimal strings; SQLite REAL is never an
-- accounting representation.
CREATE TABLE IF NOT EXISTS provider_requests (
    id                       INTEGER NOT NULL PRIMARY KEY,
    inference_call_id        INTEGER NOT NULL,
    sequence                 INTEGER NOT NULL CHECK (sequence >= 1),
    provider                 TEXT    NOT NULL CHECK (length(provider) > 0),
    model                    TEXT    NOT NULL CHECK (length(model) > 0),
    state                    TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'settled')),
    outcome                  TEXT             CHECK (outcome IN ('response', 'error')),
    status                   INTEGER          CHECK (status IS NULL OR status BETWEEN 100 AND 599),
    usage_input              INTEGER          CHECK (usage_input IS NULL OR usage_input >= 0),
    usage_output             INTEGER          CHECK (usage_output IS NULL OR usage_output >= 0),
    usage_total              INTEGER          CHECK (usage_total IS NULL OR usage_total >= 0),
    usage_input_no_cache     INTEGER          CHECK (usage_input_no_cache IS NULL OR usage_input_no_cache >= 0),
    usage_input_cache_read   INTEGER          CHECK (usage_input_cache_read IS NULL OR usage_input_cache_read >= 0),
    usage_input_cache_write  INTEGER          CHECK (usage_input_cache_write IS NULL OR usage_input_cache_write >= 0),
    usage_output_text        INTEGER          CHECK (usage_output_text IS NULL OR usage_output_text >= 0),
    usage_output_reasoning   INTEGER          CHECK (usage_output_reasoning IS NULL OR usage_output_reasoning >= 0),
    cost_kind                TEXT             CHECK (cost_kind IN ('charged', 'estimated', 'unknown')),
    cost_amount              TEXT,
    cost_currency            TEXT,
    cost_usd_equivalent      TEXT,
    cost_source              TEXT,
    cost_reason              TEXT,
    started_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at             TEXT,
    CHECK (
        (state = 'pending'
            AND outcome IS NULL AND status IS NULL
            AND usage_input IS NULL AND usage_output IS NULL AND usage_total IS NULL
            AND usage_input_no_cache IS NULL AND usage_input_cache_read IS NULL
            AND usage_input_cache_write IS NULL AND usage_output_text IS NULL
            AND usage_output_reasoning IS NULL
            AND cost_kind IS NULL AND cost_amount IS NULL AND cost_currency IS NULL
            AND cost_usd_equivalent IS NULL AND cost_source IS NULL AND cost_reason IS NULL
            AND completed_at IS NULL)
        OR
        (state = 'settled' AND outcome IS NOT NULL AND cost_kind IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CHECK (
        cost_amount IS NULL OR (
            length(cost_amount) > 0
            AND cost_amount NOT GLOB '*[^0-9.]*'
            AND cost_amount NOT LIKE '.%'
            AND cost_amount NOT LIKE '%.'
            AND cost_amount NOT LIKE '%.%.%'
            AND (cost_amount = '0' OR cost_amount NOT GLOB '0[0-9]*')
        )
    ),
    CHECK (
        cost_usd_equivalent IS NULL OR (
            length(cost_usd_equivalent) > 0
            AND cost_usd_equivalent NOT GLOB '*[^0-9.]*'
            AND cost_usd_equivalent NOT LIKE '.%'
            AND cost_usd_equivalent NOT LIKE '%.'
            AND cost_usd_equivalent NOT LIKE '%.%.%'
            AND (cost_usd_equivalent = '0' OR cost_usd_equivalent NOT GLOB '0[0-9]*')
        )
    ),
    CHECK (
        cost_currency IS NULL OR (
            length(cost_currency) BETWEEN 3 AND 12
            AND substr(cost_currency, 1, 1) GLOB '[A-Z]'
            AND cost_currency NOT GLOB '*[^A-Z0-9]*'
        )
    ),
    CHECK (
        cost_kind IS NULL
        OR (cost_kind = 'charged'
            AND cost_amount IS NOT NULL AND cost_currency IS NOT NULL
            AND cost_source IS NOT NULL AND length(cost_source) > 0
            AND cost_reason IS NULL)
        OR (cost_kind = 'estimated'
            AND cost_amount IS NOT NULL AND cost_currency IS NOT NULL
            AND cost_usd_equivalent IS NULL
            AND cost_source IS NOT NULL AND length(cost_source) > 0
            AND cost_reason IS NULL)
        OR (cost_kind = 'unknown'
            AND cost_amount IS NULL AND cost_currency IS NULL
            AND cost_usd_equivalent IS NULL AND cost_source IS NULL
            AND cost_reason IS NOT NULL AND length(cost_reason) > 0)
    ),
    UNIQUE (inference_call_id, sequence),
    FOREIGN KEY (inference_call_id) REFERENCES inference_calls(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER IF NOT EXISTS provider_requests_pending_inference_only
BEFORE INSERT ON provider_requests
WHEN COALESCE((SELECT state = 'pending' FROM inference_calls WHERE id = NEW.inference_call_id), 0) != 1
BEGIN
    SELECT RAISE(ABORT, 'provider request requires a pending inference call');
END;

CREATE TRIGGER IF NOT EXISTS provider_requests_identity_immutable
BEFORE UPDATE OF inference_call_id, sequence, provider, model, started_at
ON provider_requests
BEGIN
    SELECT RAISE(ABORT, 'provider request identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS provider_requests_state_forward_only
BEFORE UPDATE OF state ON provider_requests
WHEN NOT (NEW.state = OLD.state OR (OLD.state = 'pending' AND NEW.state = 'settled'))
BEGIN
    SELECT RAISE(ABORT, 'provider request may only settle once');
END;

CREATE TRIGGER IF NOT EXISTS provider_requests_settlement_immutable
BEFORE UPDATE OF outcome, status,
                 usage_input, usage_output, usage_total,
                 usage_input_no_cache, usage_input_cache_read, usage_input_cache_write,
                 usage_output_text, usage_output_reasoning,
                 cost_kind, cost_amount, cost_currency, cost_usd_equivalent,
                 cost_source, cost_reason, completed_at
ON provider_requests
WHEN OLD.state != 'pending'
BEGIN
    SELECT RAISE(ABORT, 'provider request settlement is immutable');
END;

CREATE TRIGGER IF NOT EXISTS model_calls_native_inputs_valid
BEFORE UPDATE OF native_inputs ON model_calls
WHEN (
    SELECT COUNT(*) != COUNT(DISTINCT value)
        OR SUM(CASE WHEN type != 'text' OR length(value) = 0 THEN 1 ELSE 0 END) > 0
    FROM json_each(NEW.native_inputs)
)
OR EXISTS (
    SELECT 1
    FROM json_each(NEW.native_inputs) native
    WHERE NOT EXISTS (
        SELECT 1
        FROM inference_calls call
        JOIN turns request_turn ON request_turn.id = call.turn_id
        JOIN loops request_loop ON request_loop.id = request_turn.loop_id
        JOIN log_entries entry ON entry.worker_id = request_loop.worker_id
        JOIN turns entry_turn ON entry_turn.id = entry.turn_id
        JOIN loops entry_loop ON entry_loop.id = entry_turn.loop_id
        WHERE call.id = NEW.id
          AND entry.op = 'READ'
          AND entry.status_rx < 400
          AND (entry_loop.sequence || '/' || entry_turn.sequence || '/' || entry.sequence) = native.value
    )
)
BEGIN
    SELECT RAISE(ABORT, 'model call native inputs must be unique successful READ coordinates owned by its worker');
END;
