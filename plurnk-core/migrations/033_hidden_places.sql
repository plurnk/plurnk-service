-- MIGRATE: 33 hidden places
-- Released in 4.3.0 and frozen ({§db-migrations}).
-- {§place-hiding} A hidden workspace or session is marked, never deleted. A session's hide marks it and every session
-- beneath it with the session that hid it (`hidden_by`), the group that comes back whole.
ALTER TABLE workspaces ADD COLUMN hidden_at TEXT CHECK (hidden_at IS NULL OR length(hidden_at) > 0);
ALTER TABLE sessions ADD COLUMN hidden_at TEXT CHECK (hidden_at IS NULL OR length(hidden_at) > 0);
ALTER TABLE sessions ADD COLUMN hidden_by INTEGER REFERENCES sessions(id)
    CHECK ((hidden_at IS NULL) = (hidden_by IS NULL));

CREATE INDEX sessions_hidden_by ON sessions (hidden_by) WHERE hidden_by IS NOT NULL;
