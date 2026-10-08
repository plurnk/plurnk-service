-- MIGRATE: 19 interactive owners
-- {§worker-ownership} An owner states whether a person attends it. Existing owners are
-- unattended until their client declares otherwise; the runtime owner never is.

ALTER TABLE worker_owners ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0
    CHECK (interactive IN (0, 1) AND (address != '_plurnk' OR interactive = 0));
