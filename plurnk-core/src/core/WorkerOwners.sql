-- {§worker-ownership} The owner binding is separate from messages and loop admission.

-- INIT: workspace_runtime_owner
DROP TRIGGER IF EXISTS workspace_runtime_owner;
CREATE TRIGGER workspace_runtime_owner
AFTER INSERT ON workspaces
BEGIN
    INSERT INTO worker_owners (workspace_id, address, tools) VALUES (NEW.id, '_plurnk', '[]');
END;

-- INIT: worker_owner_inherit
DROP TRIGGER IF EXISTS worker_owner_inherit;
CREATE TRIGGER worker_owner_inherit
AFTER INSERT ON workers
WHEN EXISTS (SELECT 1 FROM workers WHERE id = NEW.parent_worker_id)
BEGIN
    UPDATE workers SET owner = (SELECT owner FROM workers WHERE id = NEW.parent_worker_id)
    WHERE id = NEW.id;
END;

-- PREP: worker_owner_register
INSERT INTO worker_owners (workspace_id, address, tools, interactive)
VALUES ($workspace_id, $address, $tools, $interactive)
ON CONFLICT (workspace_id, address) DO UPDATE SET tools = excluded.tools, interactive = excluded.interactive;

-- PREP: worker_owner_registered
SELECT address, tools, interactive FROM worker_owners WHERE workspace_id = $workspace_id AND address = $address;

-- PREP: worker_owner_read
SELECT o.address, o.tools, o.interactive
FROM workers w JOIN worker_owners o ON o.workspace_id = w.workspace_id AND o.address = w.owner
WHERE w.id = $worker_id;

-- PREP: worker_owner_for_loop
SELECT o.address, o.tools, o.interactive
FROM loops l JOIN workers w ON w.id = l.worker_id
JOIN worker_owners o ON o.workspace_id = w.workspace_id AND o.address = w.owner
WHERE l.id = $loop_id;

-- PREP: worker_owner_for_proposal
SELECT w.workspace_id AS workspaceId, w.owner
FROM log_entries le JOIN workers w ON w.id = le.worker_id
WHERE le.id = $log_entry_id AND le.state = 'proposed';

-- PREP: worker_owner_claim
WITH RECURSIVE tree(id) AS (
    SELECT id FROM workers
    WHERE id = $worker_id AND workspace_id = $workspace_id
      AND owner = '_plurnk' AND origin != '_plurnk'
    UNION ALL
    SELECT w.id FROM workers w JOIN tree ON w.parent_worker_id = tree.id
    WHERE w.owner = '_plurnk' AND w.origin != '_plurnk'
)
UPDATE workers SET owner = $owner
WHERE id IN (SELECT id FROM tree);
