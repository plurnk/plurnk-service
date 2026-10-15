-- MIGRATE: 30 client workers
-- {§connection-lifecycle} A worker is a model's identity: a person's client operations are the workspace's and
-- journal in its runtime worker. Each client worker's history moves there, and the emptied worker goes.
-- Rows keep their identity; only their worker, and their loop's place in that worker's numbering, change.

-- The runtime worker of every workspace that holds a client worker.
INSERT INTO workers (workspace_id, name, origin)
SELECT DISTINCT client.workspace_id, '_plurnk', '_plurnk'
FROM workers client
WHERE client.origin = 'client'
  AND NOT EXISTS (SELECT 1 FROM workers runtime WHERE runtime.workspace_id = client.workspace_id AND runtime.origin = '_plurnk');

-- {§actor-boundary-client-operations} The person who owned a client worker acted in each of its loops.
CREATE TEMP TABLE rehomed_workers AS
SELECT client.id AS client_id, runtime.id AS runtime_id,
       CASE WHEN client.owner = '_plurnk' THEN NULL ELSE client.owner END AS person
FROM workers client
JOIN workers runtime ON runtime.workspace_id = client.workspace_id AND runtime.origin = '_plurnk'
WHERE client.origin = 'client';

-- Each client loop follows the runtime worker's own loops, in the order the loops ran.
CREATE TEMP TABLE rehomed_loops AS
SELECT l.id AS loop_id, l.worker_id AS client_id, l.sequence AS client_sequence, moved.runtime_id,
       (SELECT coalesce(max(own.sequence), 0) FROM loops own WHERE own.worker_id = moved.runtime_id)
           + row_number() OVER (PARTITION BY moved.runtime_id ORDER BY l.id) AS sequence,
       moved.person
FROM loops l
JOIN rehomed_workers moved ON moved.client_id = l.worker_id;

UPDATE loops
SET worker_id = moved.runtime_id,
    sequence = moved.sequence,
    prompt_source = coalesce(loops.prompt_source, moved.person)
FROM rehomed_loops moved
WHERE moved.loop_id = loops.id;

-- The two identity guards are redeclared verbatim once their rows have moved.
DROP TRIGGER log_entries_immutable_core;

UPDATE log_entries SET worker_id = moved.runtime_id
FROM rehomed_workers moved
WHERE moved.client_id = log_entries.worker_id;

CREATE TRIGGER log_entries_immutable_core
BEFORE UPDATE OF
    worker_id, loop_id, turn_id, sequence, at, origin, source, inherited_history, model_call_id,
    op, signal,
    scheme, username, password, hostname,
    port, pathname, query, fragment,
    lineMarker, tx, mimetype_tx, mimetype_rx, initial_folded
ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only lifecycle outcome and derived attachments may change');
END;

-- An execution's source names its row by log coordinate, so it takes its loop's new number.
DROP TRIGGER subscriptions_identity_update;

UPDATE subscriptions
SET worker_id = moved.runtime_id,
    source = coalesce(
        'log:///' || (
            SELECT l.sequence FROM rehomed_loops l
            WHERE l.client_id = moved.client_id
              AND l.client_sequence = CAST(substr(subscriptions.source, 8, instr(substr(subscriptions.source, 8), '/') - 1) AS INTEGER)
        ) || substr(subscriptions.source, 7 + instr(substr(subscriptions.source, 8), '/')),
        subscriptions.source)
FROM rehomed_workers moved
WHERE moved.client_id = subscriptions.worker_id;

CREATE TRIGGER subscriptions_identity_update
BEFORE UPDATE OF worker_id, entry_id, scheme, source ON subscriptions
WHEN NEW.entry_id != OLD.entry_id OR NEW.scheme != OLD.scheme OR NEW.source IS NOT OLD.source
  OR (NEW.worker_id IS NOT OLD.worker_id AND NOT (NEW.worker_id IS NULL AND NEW.closed_at IS NOT NULL))
BEGIN
    SELECT RAISE(ABORT, 'subscription identity is immutable');
END;

UPDATE ambient_events SET producer_worker_id = moved.runtime_id
FROM rehomed_workers moved
WHERE moved.client_id = ambient_events.producer_worker_id;

UPDATE ambient_events SET recipient_worker_id = moved.runtime_id
FROM rehomed_workers moved
WHERE moved.client_id = ambient_events.recipient_worker_id;

UPDATE client_interactions SET worker_id = moved.runtime_id
FROM rehomed_workers moved
WHERE moved.client_id = client_interactions.worker_id;

-- A worker a client worker parented becomes the runtime worker's child, as a hosted A2A task is.
UPDATE workers SET parent_worker_id = moved.runtime_id
FROM rehomed_workers moved
WHERE moved.client_id = workers.parent_worker_id;

-- {§env-scheme} A person's environment is the runtime worker's; overrides several persons kept have no one owner.
DELETE FROM worker_module_state WHERE worker_id IN (SELECT client_id FROM rehomed_workers);

DELETE FROM workers WHERE id IN (SELECT client_id FROM rehomed_workers);

DROP TABLE rehomed_loops;
DROP TABLE rehomed_workers;

-- No worker carries the default flag any longer.
DROP INDEX workers_workspace_default_worker;
