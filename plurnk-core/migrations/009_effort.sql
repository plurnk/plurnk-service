-- MIGRATE: 9 effort
-- Released in 1.22.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- #877 renames the reasoning policy to effort ({§worker-effort}, {§worker-effort-source}).
-- RENAME COLUMN rewrites the CHECK constraints that name these columns.
ALTER TABLE workers RENAME COLUMN reasoning_policy TO effort;
ALTER TABLE workers RENAME COLUMN reasoning_source TO effort_source;
ALTER TABLE loops RENAME COLUMN reasoning_policy TO effort;
