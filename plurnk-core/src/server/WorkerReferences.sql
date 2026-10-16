-- {§worker-external-reference} A bound statement admits the entire allocation, or nothing.
-- INIT: worker_reference_allocate
DROP TRIGGER IF EXISTS worker_reference_allocate;
CREATE TRIGGER worker_reference_allocate
INSTEAD OF INSERT ON worker_reference_allocations
BEGIN
    INSERT INTO workspaces (name) VALUES (NEW.workspace_name);
    INSERT INTO workers (workspace_id, name, origin)
    SELECT id, NEW.worker_name, 'model' FROM workspaces WHERE name = NEW.workspace_name;
    INSERT INTO worker_references (namespace, reference, worker_id)
    SELECT NEW.namespace, NEW.reference, w.id
    FROM workers w JOIN workspaces s ON s.id = w.workspace_id
    WHERE s.name = NEW.workspace_name AND w.name = NEW.worker_name;
END;

-- PREP: worker_reference_allocate
INSERT INTO worker_reference_allocations (namespace, reference, workspace_name, worker_name)
SELECT $namespace, $reference, $workspace_name, $worker_name
WHERE NOT EXISTS (SELECT 1 FROM worker_references WHERE namespace = $namespace AND reference = $reference)
  AND NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $workspace_name)
RETURNING namespace, reference;

-- PREP: worker_reference_read
SELECT w.workspace_id AS workspaceId, w.id AS workerId
FROM worker_references r JOIN workers w ON w.id = r.worker_id
WHERE r.namespace = $namespace AND r.reference = $reference;

-- PREP: worker_reference_list
SELECT reference FROM worker_references
WHERE namespace = $namespace AND worker_id = $worker_id
ORDER BY reference;
