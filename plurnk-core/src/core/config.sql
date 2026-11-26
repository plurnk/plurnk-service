-- Durable service-wide and workspace-scoped configuration and daemon-wide module state.
-- {§operator-config-precedence} {§functionality-coordinator}

-- PREP: service_config_list
SELECT key, value, updated_at
FROM service_config
ORDER BY key ASC;

-- PREP: service_config_get
SELECT key, value, updated_at
FROM service_config
WHERE key = $key;

-- PREP: service_config_put
INSERT INTO service_config (key, value, updated_at)
VALUES ($key, $value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT (key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at;

-- PREP: service_config_delete
DELETE FROM service_config
WHERE key = $key;

-- PREP: workspace_config_list
SELECT key, value, updated_at
FROM workspace_config
WHERE workspace_id = $workspace_id
ORDER BY key ASC;

-- PREP: workspace_config_get
SELECT key, value, updated_at
FROM workspace_config
WHERE workspace_id = $workspace_id
  AND key = $key;

-- PREP: workspace_config_put
INSERT INTO workspace_config (workspace_id, key, value, updated_at)
VALUES ($workspace_id, $key, $value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT (workspace_id, key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at;

-- PREP: workspace_config_delete
DELETE FROM workspace_config
WHERE workspace_id = $workspace_id
  AND key = $key;

-- PREP: service_module_state_get
SELECT state
FROM service_module_state
WHERE namespace_owner = $namespace_owner;

-- PREP: service_module_state_put
INSERT INTO service_module_state (namespace_owner, state)
VALUES ($namespace_owner, $state)
ON CONFLICT (namespace_owner) DO UPDATE SET
    state = excluded.state;

-- PREP: service_module_state_delete
DELETE FROM service_module_state
WHERE namespace_owner = $namespace_owner;
