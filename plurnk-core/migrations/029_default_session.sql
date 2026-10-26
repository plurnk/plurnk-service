-- MIGRATE: 29 default session
-- Released in 4.0.0 and frozen ({§db-migrations}).
-- The column that marks a workspace's one flagged root model session takes the session vocabulary.
-- Renaming it rewrites its CHECK and the partial index in place; the index then takes its name.
ALTER TABLE sessions RENAME COLUMN default_conversation TO default_session;

DROP INDEX sessions_workspace_default_conversation;
CREATE UNIQUE INDEX sessions_workspace_default_session
    ON sessions (workspace_id) WHERE default_session = 1;
