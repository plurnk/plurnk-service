-- Durable module-owned Worker state. {§module-worker-state}

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

-- PREP: worker_module_states_by_workspace
-- Every worker of a workspace with its durable state for one namespace owner (NULL when none):
-- the members family unions desired state across workers ({§members-projection}).
SELECT w.id AS worker_id, s.state
FROM workers w
LEFT JOIN worker_module_state s ON s.worker_id = w.id AND s.namespace_owner = $namespace_owner
WHERE w.workspace_id = $workspace_id
ORDER BY w.id;

-- PREP: worker_module_state_delete
DELETE FROM worker_module_state
WHERE worker_id = $worker_id
  AND namespace_owner = $namespace_owner;
