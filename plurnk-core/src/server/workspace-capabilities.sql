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

-- INIT: workers_inherit_module_state
-- {§functionality-scope} — a Worker created with a parent (WORK and FORK alike) starts with a copy
-- of the parent's worker-scoped state, taken at creation: the child owns its copy, and neither
-- side's later edits reach the other. Each copied entry names its source Worker (`inherited`),
-- preserved across generations, so `list` renders provenance rather than claiming the child set it.
DROP TRIGGER IF EXISTS workers_inherit_module_state;
CREATE TRIGGER workers_inherit_module_state
AFTER INSERT ON workers
WHEN NEW.parent_worker_id IS NOT NULL
BEGIN
    INSERT INTO worker_module_state (worker_id, namespace_owner, state)
    SELECT NEW.id, s.namespace_owner,
           json_set(s.state, '$.definitions', coalesce(
               (SELECT json_group_object(key,
                           CASE WHEN json_extract(value, '$.inherited') IS NULL
                                THEN json_set(value, '$.inherited', (SELECT name FROM workers WHERE id = NEW.parent_worker_id))
                                ELSE json(value) END)
                FROM json_each(s.state, '$.definitions')),
               json('{}')))
    FROM worker_module_state s
    WHERE s.worker_id = NEW.parent_worker_id;
END;
