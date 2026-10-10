-- MIGRATE: 19 interactive owners
-- Released in 3.0.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§worker-ownership} An owner states whether a person attends it. Existing owners are
-- unattended until their client declares otherwise; the runtime owner never is.

ALTER TABLE worker_owners ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0
    CHECK (interactive IN (0, 1) AND (address != '_plurnk' OR interactive = 0));
