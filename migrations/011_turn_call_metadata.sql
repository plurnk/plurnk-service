-- INIT: turn_call_metadata
-- Adds Turn-level call metadata fields per plurnk-grammar 0.6.0 Turn.json:
-- finish_reason and model are properties of the provider call, not the
-- model's emission payload. They belong on the Turn row alongside usage,
-- not nested into packet.assistant (which is "what the model said").
ALTER TABLE turns ADD COLUMN finish_reason TEXT;
ALTER TABLE turns ADD COLUMN model         TEXT NOT NULL DEFAULT 'unknown' CHECK (length(model) >= 1);
