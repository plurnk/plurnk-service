-- INIT: persona_columns
-- Three-level persona cascade (issue #150). packet.system.persona is
-- resolved at packet-build time by taking the first non-null value of:
--   loops.persona > runs.persona > sessions.persona > PATHS.defaultPersona
--
-- Nullable everywhere; null means "fall through to the next level." The
-- file-based default catches the case where no level was set via RPC.
-- Persona content is text/markdown per @plurnk/plurnk-grammar Packet.json.
ALTER TABLE sessions ADD COLUMN persona TEXT;
ALTER TABLE runs     ADD COLUMN persona TEXT;
ALTER TABLE loops    ADD COLUMN persona TEXT;
