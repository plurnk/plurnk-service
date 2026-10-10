-- MIGRATE: 18 worker owners
-- Released in 3.0.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§worker-owner-creation} Ownership is durable; incoming messages confer no authority.

CREATE TABLE worker_owners (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    address TEXT NOT NULL CHECK (length(address) > 0),
    tools TEXT NOT NULL CHECK (json_valid(tools) AND json_type(tools) = 'array'),
    PRIMARY KEY (workspace_id, address),
    CHECK (address != '_plurnk' OR tools = '[]')
) STRICT;

INSERT INTO worker_owners (workspace_id, address, tools)
SELECT id, '_plurnk', '[]' FROM workspaces;

ALTER TABLE workers ADD COLUMN owner TEXT NOT NULL DEFAULT '_plurnk' CHECK (length(owner) > 0);

-- SQLite cannot add a composite foreign key to an existing table. These guards enforce
-- the same workspace/address reference without rebuilding workers and their descendants.
CREATE TRIGGER worker_owner_insert
BEFORE INSERT ON workers
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id) AND NOT EXISTS (
    SELECT 1 FROM worker_owners WHERE workspace_id = NEW.workspace_id AND address = NEW.owner
)
OR (NEW.origin = '_plurnk' AND NEW.owner != '_plurnk')
OR (NEW.parent_worker_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM workers WHERE id = NEW.parent_worker_id AND workspace_id != NEW.workspace_id
))
BEGIN
    SELECT RAISE(ABORT, 'worker owner or parent does not belong to its workspace');
END;

CREATE TRIGGER worker_owner_update
BEFORE UPDATE OF owner, workspace_id ON workers
WHEN NOT EXISTS (
    SELECT 1 FROM worker_owners WHERE workspace_id = NEW.workspace_id AND address = NEW.owner
)
OR (NEW.origin = '_plurnk' AND NEW.owner != '_plurnk')
BEGIN
    SELECT RAISE(ABORT, 'worker owner does not belong to its workspace');
END;

CREATE TRIGGER worker_owner_identity
BEFORE UPDATE OF workspace_id, address ON worker_owners
BEGIN
    SELECT RAISE(ABORT, 'worker owner identity is immutable');
END;

CREATE TRIGGER worker_owner_referenced
BEFORE DELETE ON worker_owners
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
AND EXISTS (SELECT 1 FROM workers WHERE workspace_id = OLD.workspace_id AND owner = OLD.address)
BEGIN
    SELECT RAISE(ABORT, 'worker owner is still referenced');
END;

CREATE INDEX workers_owner ON workers (workspace_id, owner);

-- {§a2a-worker-ownership} Released A2A contexts were roots. Retained causal
-- message identities distinguish them from ordinary model conversations.
CREATE TEMP TABLE a2a_context_parents AS
SELECT DISTINCT context.id, context.workspace_id
FROM workers context
JOIN workers task ON task.parent_worker_id = context.id
JOIN loops l ON l.worker_id = task.id
WHERE context.origin = 'model' AND context.parent_worker_id IS NULL
  AND context.default_conversation = 0 AND task.origin = 'model'
  AND l.prompt_source GLOB 'a2a://*'
  AND instr(l.prompt_source, '/contexts/' || context.name || '/tasks/' || task.name || '/messages/') > 0
  AND substr(l.prompt_source, -1) != '/';

INSERT INTO workers (workspace_id, name, origin)
SELECT DISTINCT context.workspace_id, '_plurnk', '_plurnk'
FROM a2a_context_parents context
WHERE NOT EXISTS (SELECT 1 FROM workers runtime WHERE runtime.workspace_id = context.workspace_id AND runtime.origin = '_plurnk');

UPDATE workers SET parent_worker_id = (
    SELECT runtime.id FROM workers runtime
    WHERE runtime.workspace_id = workers.workspace_id AND runtime.origin = '_plurnk'
)
WHERE id IN (SELECT id FROM a2a_context_parents);
DROP TABLE a2a_context_parents;

-- Old process-local interaction waiters cannot survive a daemon restart; ordinary
-- orphan recovery settles these rows without inventing a client for them.
ALTER TABLE client_interactions ADD COLUMN recipient TEXT NOT NULL DEFAULT '_plurnk';

-- The runtime installs the current fork trigger after migrations.
DROP TRIGGER IF EXISTS workers_fork_copies_history;
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
