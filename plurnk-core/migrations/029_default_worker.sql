-- MIGRATE: 29 default worker
-- {§methods-model-worker}: the workspace's durable default role is the default worker's. Renaming the
-- column rewrites its CHECK and the partial index in place; the index then takes the role's name.
ALTER TABLE workers RENAME COLUMN default_conversation TO default_worker;

DROP INDEX workers_workspace_default_conversation;
CREATE UNIQUE INDEX workers_workspace_default_worker
    ON workers (workspace_id) WHERE default_worker = 1;
