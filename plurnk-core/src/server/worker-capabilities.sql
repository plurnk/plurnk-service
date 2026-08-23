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

-- PREP: worker_module_state_delete
DELETE FROM worker_module_state
WHERE worker_id = $worker_id
  AND namespace_owner = $namespace_owner;
