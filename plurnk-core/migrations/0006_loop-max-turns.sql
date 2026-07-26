-- MIGRATE: 6 loop_max_turns
ALTER TABLE loops
ADD COLUMN max_turns INTEGER NOT NULL DEFAULT 50 CHECK (max_turns >= -1);
