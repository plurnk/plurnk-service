-- MIGRATE: 33 hidden places
-- Released in 4.3.0 and frozen ({§db-migrations}).
-- {§place-hiding} A hidden workspace or worker is marked, never deleted. A worker's hide marks it and every worker
-- beneath it with the worker that hid it (`hidden_by`), the group that comes back whole.
ALTER TABLE workspaces ADD COLUMN hidden_at TEXT CHECK (hidden_at IS NULL OR length(hidden_at) > 0);
ALTER TABLE workers ADD COLUMN hidden_at TEXT CHECK (hidden_at IS NULL OR length(hidden_at) > 0);
ALTER TABLE workers ADD COLUMN hidden_by INTEGER REFERENCES workers(id)
    CHECK ((hidden_at IS NULL) = (hidden_by IS NULL));

CREATE INDEX workers_hidden_by ON workers (hidden_by) WHERE hidden_by IS NOT NULL;
