-- {§module-workspace-directory} — one atomic allocation; opening a second module
-- or racing the first lookup cannot replace the workspace's existing identity.
-- PREP: workspace_storage_key
INSERT INTO workspace_module_state (workspace_id, namespace_owner, state)
SELECT id, '@plurnk/plurnk-service/storage', json_object('key', lower(hex(randomblob(16))))
FROM workspaces WHERE id = $workspace_id
ON CONFLICT (workspace_id, namespace_owner) DO UPDATE SET state = workspace_module_state.state
RETURNING state;

-- PREP: workspace_storage_roots
SELECT workspace_id, state
FROM workspace_module_state
WHERE namespace_owner = '@plurnk/plurnk-service/storage';
