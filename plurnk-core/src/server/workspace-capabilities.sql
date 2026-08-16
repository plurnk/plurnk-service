-- Durable module-owned workspace state. {§module-workspace-state}

-- PREP: workspace_module_state_get
SELECT state
FROM workspace_module_state
WHERE workspace_id = $workspace_id
  AND namespace_owner = $namespace_owner;

-- PREP: workspace_module_state_put
INSERT INTO workspace_module_state (workspace_id, namespace_owner, state)
VALUES ($workspace_id, $namespace_owner, $state)
ON CONFLICT (workspace_id, namespace_owner) DO UPDATE SET
    state = excluded.state,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- PREP: workspace_module_state_delete
DELETE FROM workspace_module_state
WHERE workspace_id = $workspace_id
  AND namespace_owner = $namespace_owner;
