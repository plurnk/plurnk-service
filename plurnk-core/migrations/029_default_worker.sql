-- MIGRATE: 29 default worker
-- The column that marks a workspace's one flagged root model worker takes the worker vocabulary.
-- Renaming it rewrites its CHECK and the partial index in place; the index then takes its name.
ALTER TABLE workers RENAME COLUMN default_conversation TO default_worker;

DROP INDEX workers_workspace_default_conversation;
CREATE UNIQUE INDEX workers_workspace_default_worker
    ON workers (workspace_id) WHERE default_worker = 1;
