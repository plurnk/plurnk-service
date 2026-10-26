-- {§session-external-reference} A bound statement admits the entire allocation, or nothing.
-- INIT: session_reference_allocate
DROP TRIGGER IF EXISTS session_reference_allocate;
CREATE TRIGGER session_reference_allocate
INSTEAD OF INSERT ON session_reference_allocations
BEGIN
    INSERT INTO workspaces (name) VALUES (NEW.workspace_name);
    INSERT INTO sessions (workspace_id, name, origin)
    SELECT id, NEW.session_name, 'model' FROM workspaces WHERE name = NEW.workspace_name;
    INSERT INTO session_references (namespace, reference, session_id)
    SELECT NEW.namespace, NEW.reference, w.id
    FROM sessions w JOIN workspaces s ON s.id = w.workspace_id
    WHERE s.name = NEW.workspace_name AND w.name = NEW.session_name;
END;

-- PREP: session_reference_allocate
INSERT INTO session_reference_allocations (namespace, reference, workspace_name, session_name)
SELECT $namespace, $reference, $workspace_name, $session_name
WHERE NOT EXISTS (SELECT 1 FROM session_references WHERE namespace = $namespace AND reference = $reference)
  AND NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $workspace_name)
RETURNING namespace, reference;

-- PREP: session_reference_read
SELECT w.workspace_id AS workspaceId, w.id AS sessionId
FROM session_references r JOIN sessions w ON w.id = r.session_id
WHERE r.namespace = $namespace AND r.reference = $reference;

-- PREP: session_reference_list
SELECT reference FROM session_references
WHERE namespace = $namespace AND session_id = $session_id
ORDER BY reference;
