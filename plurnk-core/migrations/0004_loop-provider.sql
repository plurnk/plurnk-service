-- MIGRATE: 4 loop_provider
ALTER TABLE loops
ADD COLUMN provider_spec TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(provider_spec));
