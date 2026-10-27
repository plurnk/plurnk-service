-- Durable workspace module state. {§module-lifecycle}

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

-- Session-scoped module state ({§module-lifecycle}). Same snapshot, different owner: a
-- family declares its scope and the coordinator keys state by it, so origin, enabledness and the
-- service-baseline rules stay one implementation across every family.

-- PREP: session_module_state_get
SELECT state
FROM session_module_state
WHERE session_id = $session_id
  AND namespace_owner = $namespace_owner;

-- PREP: session_module_state_put
INSERT INTO session_module_state (session_id, namespace_owner, state)
VALUES ($session_id, $namespace_owner, $state)
ON CONFLICT (session_id, namespace_owner) DO UPDATE SET
    state = excluded.state,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- PREP: session_module_state_delete
DELETE FROM session_module_state
WHERE session_id = $session_id
  AND namespace_owner = $namespace_owner;

-- INIT: sessions_inherit_module_state
-- {§functionality-coordinator} — a Session created with a parent (WORK and FORK alike) starts with a copy
-- of the parent's session-scoped state, taken at creation: the child owns its copy, and neither
-- side's later edits reach the other. Each copied entry names its source Session (`inherited`),
-- preserved across generations, so `list` renders provenance rather than claiming the child set it.
DROP TRIGGER IF EXISTS sessions_inherit_module_state;
CREATE TRIGGER sessions_inherit_module_state
AFTER INSERT ON sessions
WHEN NEW.parent_session_id IS NOT NULL
BEGIN
    INSERT INTO session_module_state (session_id, namespace_owner, state)
    SELECT NEW.id, s.namespace_owner,
           json_set(s.state, '$.definitions', coalesce(
               (SELECT json_group_object(key,
                           CASE WHEN json_extract(value, '$.inherited') IS NULL
                                THEN json_set(value, '$.inherited', (SELECT name FROM sessions WHERE id = NEW.parent_session_id))
                                ELSE json(value) END)
                FROM json_each(s.state, '$.definitions')),
               json('{}')))
    FROM session_module_state s
    WHERE s.session_id = NEW.parent_session_id;
END;
