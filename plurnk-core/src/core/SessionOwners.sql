-- {§session-ownership} The owner binding is separate from messages and loop admission.

-- INIT: workspace_runtime_owner
DROP TRIGGER IF EXISTS workspace_runtime_owner;
CREATE TRIGGER workspace_runtime_owner
AFTER INSERT ON workspaces
BEGIN
    INSERT INTO session_owners (workspace_id, address, tools) VALUES (NEW.id, '_plurnk', '[]');
END;

-- INIT: session_owner_inherit
DROP TRIGGER IF EXISTS session_owner_inherit;
CREATE TRIGGER session_owner_inherit
AFTER INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM sessions WHERE id = NEW.parent_session_id)
BEGIN
    UPDATE sessions SET owner = (SELECT owner FROM sessions WHERE id = NEW.parent_session_id)
    WHERE id = NEW.id;
END;

-- PREP: session_owner_register
INSERT INTO session_owners (workspace_id, address, tools, interactive)
VALUES ($workspace_id, $address, $tools, $interactive)
ON CONFLICT (workspace_id, address) DO UPDATE SET tools = excluded.tools, interactive = excluded.interactive;

-- PREP: session_owner_admit
-- {§actor-boundary-client-operations} A person who starts a session by operation owns it; an owner already
-- registered keeps its tools and attendance.
INSERT INTO session_owners (workspace_id, address, tools, interactive)
VALUES ($workspace_id, $address, '[]', 0)
ON CONFLICT (workspace_id, address) DO NOTHING;

-- PREP: session_owner_registered
SELECT address, tools, interactive FROM session_owners WHERE workspace_id = $workspace_id AND address = $address;

-- PREP: session_owner_read
SELECT o.address, o.tools, o.interactive
FROM sessions w JOIN session_owners o ON o.workspace_id = w.workspace_id AND o.address = w.owner
WHERE w.id = $session_id;

-- PREP: session_owner_for_loop
SELECT o.address, o.tools, o.interactive
FROM loops l JOIN sessions w ON w.id = l.session_id
JOIN session_owners o ON o.workspace_id = w.workspace_id AND o.address = w.owner
WHERE l.id = $loop_id;

-- PREP: session_owner_for_proposal
SELECT w.workspace_id AS workspaceId, w.owner
FROM log_entries le JOIN sessions w ON w.id = le.session_id
WHERE le.id = $log_entry_id AND le.state = 'proposed';

-- PREP: session_owner_claim
WITH RECURSIVE tree(id) AS (
    SELECT id FROM sessions
    WHERE id = $session_id AND workspace_id = $workspace_id
      AND origin != '_plurnk'
    UNION ALL
    SELECT w.id FROM sessions w JOIN tree ON w.parent_session_id = tree.id
    WHERE w.origin != '_plurnk'
)
UPDATE sessions SET owner = $owner
WHERE id IN (SELECT id FROM tree);

-- PREP: session_owner_claim_interactions
UPDATE client_interactions
SET recipient = $owner
WHERE session_id IN (
    WITH RECURSIVE tree(id) AS (
        SELECT id FROM sessions
        WHERE id = $session_id AND workspace_id = $workspace_id
          AND origin != '_plurnk'
        UNION ALL
        SELECT w.id FROM sessions w JOIN tree ON w.parent_session_id = tree.id
        WHERE w.origin != '_plurnk'
    )
    SELECT id FROM tree
);
