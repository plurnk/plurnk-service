-- Durable workspace module state. {§module-workspace-state}

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

-- Worker-scoped module state ({§module-workspace-state}). Same snapshot, different owner: a
-- family declares its scope and the coordinator keys state by it, so origin, enabledness and the
-- service-baseline rules stay one implementation across every family.

-- PREP: worker_module_state_get
SELECT state
FROM worker_module_state
WHERE worker_id = $worker_id
  AND namespace_owner = $namespace_owner;

-- PREP: worker_module_state_put
INSERT INTO worker_module_state (worker_id, namespace_owner, state)
VALUES ($worker_id, $namespace_owner, $state)
ON CONFLICT (worker_id, namespace_owner) DO UPDATE SET
    state = excluded.state,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- PREP: worker_module_state_delete
DELETE FROM worker_module_state
WHERE worker_id = $worker_id
  AND namespace_owner = $namespace_owner;
