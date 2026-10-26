-- MIGRATE: 18 session owners
-- Released in 3.0.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§session-owner-creation} Ownership is durable; incoming messages confer no authority.

CREATE TABLE session_owners (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    address TEXT NOT NULL CHECK (length(address) > 0),
    tools TEXT NOT NULL CHECK (json_valid(tools) AND json_type(tools) = 'array'),
    PRIMARY KEY (workspace_id, address),
    CHECK (address != '_plurnk' OR tools = '[]')
) STRICT;

INSERT INTO session_owners (workspace_id, address, tools)
SELECT id, '_plurnk', '[]' FROM workspaces;

ALTER TABLE sessions ADD COLUMN owner TEXT NOT NULL DEFAULT '_plurnk' CHECK (length(owner) > 0);

-- SQLite cannot add a composite foreign key to an existing table. These guards enforce
-- the same workspace/address reference without rebuilding sessions and their descendants.
CREATE TRIGGER session_owner_insert
BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id) AND NOT EXISTS (
    SELECT 1 FROM session_owners WHERE workspace_id = NEW.workspace_id AND address = NEW.owner
)
OR (NEW.origin = '_plurnk' AND NEW.owner != '_plurnk')
OR (NEW.parent_session_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM sessions WHERE id = NEW.parent_session_id AND workspace_id != NEW.workspace_id
))
BEGIN
    SELECT RAISE(ABORT, 'session owner or parent does not belong to its workspace');
END;

CREATE TRIGGER session_owner_update
BEFORE UPDATE OF owner, workspace_id ON sessions
WHEN NOT EXISTS (
    SELECT 1 FROM session_owners WHERE workspace_id = NEW.workspace_id AND address = NEW.owner
)
OR (NEW.origin = '_plurnk' AND NEW.owner != '_plurnk')
BEGIN
    SELECT RAISE(ABORT, 'session owner does not belong to its workspace');
END;

CREATE TRIGGER session_owner_identity
BEFORE UPDATE OF workspace_id, address ON session_owners
BEGIN
    SELECT RAISE(ABORT, 'session owner identity is immutable');
END;

CREATE TRIGGER session_owner_referenced
BEFORE DELETE ON session_owners
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
AND EXISTS (SELECT 1 FROM sessions WHERE workspace_id = OLD.workspace_id AND owner = OLD.address)
BEGIN
    SELECT RAISE(ABORT, 'session owner is still referenced');
END;

CREATE INDEX sessions_owner ON sessions (workspace_id, owner);

-- Old process-local interaction waiters cannot survive a daemon restart; ordinary
-- orphan recovery settles these rows without inventing a client for them.
ALTER TABLE client_interactions ADD COLUMN recipient TEXT NOT NULL DEFAULT '_plurnk';

-- The runtime installs the current fork trigger after migrations.
DROP TRIGGER IF EXISTS sessions_fork_copies_history;
ALTER TABLE loops DROP COLUMN policy;

-- {§schedule-delivery} A stored schedule remains a message definition, not an
-- approval grant. Preserve its rule, target, prompt, enabled state and provenance.
UPDATE workspace_module_state
SET state = json_set(state, '$.definitions', (
    SELECT json_group_object(key, json_remove(value, '$.definition.policy'))
    FROM json_each(state, '$.definitions')
))
WHERE namespace_owner = '@plurnk/plurnk-schedule'
AND EXISTS (
    SELECT 1 FROM json_each(state, '$.definitions')
    WHERE json_type(value, '$.definition.policy') IS NOT NULL
);
