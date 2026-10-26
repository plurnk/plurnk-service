-- MIGRATE: 30 client sessions
-- Released in 4.0.0 and frozen ({§db-migrations}).
-- {§connection-lifecycle} A session is a model's identity: a person's client operations are the workspace's and
-- journal in its runtime session. Each client session's history moves there, and the emptied session goes.
-- Rows keep their identity; only their session, and their loop's place in that session's numbering, change.

-- The runtime session of every workspace that holds a client session.
INSERT INTO sessions (workspace_id, name, origin)
SELECT DISTINCT client.workspace_id, '_plurnk', '_plurnk'
FROM sessions client
WHERE client.origin = 'client'
  AND NOT EXISTS (SELECT 1 FROM sessions runtime WHERE runtime.workspace_id = client.workspace_id AND runtime.origin = '_plurnk');

-- {§actor-boundary-client-operations} The person who owned a client session acted in each of its loops.
CREATE TEMP TABLE rehomed_sessions AS
SELECT client.id AS client_id, runtime.id AS runtime_id,
       CASE WHEN client.owner = '_plurnk' THEN NULL ELSE client.owner END AS person
FROM sessions client
JOIN sessions runtime ON runtime.workspace_id = client.workspace_id AND runtime.origin = '_plurnk'
WHERE client.origin = 'client';

-- Each client loop follows the runtime session's own loops, in the order the loops ran.
CREATE TEMP TABLE rehomed_loops AS
SELECT l.id AS loop_id, l.session_id AS client_id, l.sequence AS client_sequence, moved.runtime_id,
       (SELECT coalesce(max(own.sequence), 0) FROM loops own WHERE own.session_id = moved.runtime_id)
           + row_number() OVER (PARTITION BY moved.runtime_id ORDER BY l.id) AS sequence,
       moved.person
FROM loops l
JOIN rehomed_sessions moved ON moved.client_id = l.session_id;

UPDATE loops
SET session_id = moved.runtime_id,
    sequence = moved.sequence,
    prompt_source = coalesce(loops.prompt_source, moved.person)
FROM rehomed_loops moved
WHERE moved.loop_id = loops.id;

-- The two identity guards are redeclared verbatim once their rows have moved.
DROP TRIGGER log_entries_immutable_core;

UPDATE log_entries SET session_id = moved.runtime_id
FROM rehomed_sessions moved
WHERE moved.client_id = log_entries.session_id;

CREATE TRIGGER log_entries_immutable_core
BEFORE UPDATE OF
    session_id, loop_id, turn_id, sequence, at, origin, source, inherited_history, model_call_id,
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
SET session_id = moved.runtime_id,
    source = coalesce(
        'log:///' || (
            SELECT l.sequence FROM rehomed_loops l
            WHERE l.client_id = moved.client_id
              AND l.client_sequence = CAST(substr(subscriptions.source, 8, instr(substr(subscriptions.source, 8), '/') - 1) AS INTEGER)
        ) || substr(subscriptions.source, 7 + instr(substr(subscriptions.source, 8), '/')),
        subscriptions.source)
FROM rehomed_sessions moved
WHERE moved.client_id = subscriptions.session_id;

CREATE TRIGGER subscriptions_identity_update
BEFORE UPDATE OF session_id, entry_id, scheme, source ON subscriptions
WHEN NEW.entry_id != OLD.entry_id OR NEW.scheme != OLD.scheme OR NEW.source IS NOT OLD.source
  OR (NEW.session_id IS NOT OLD.session_id AND NOT (NEW.session_id IS NULL AND NEW.closed_at IS NOT NULL))
BEGIN
    SELECT RAISE(ABORT, 'subscription identity is immutable');
END;

UPDATE ambient_events SET producer_session_id = moved.runtime_id
FROM rehomed_sessions moved
WHERE moved.client_id = ambient_events.producer_session_id;

UPDATE ambient_events SET recipient_session_id = moved.runtime_id
FROM rehomed_sessions moved
WHERE moved.client_id = ambient_events.recipient_session_id;

UPDATE client_interactions SET session_id = moved.runtime_id
FROM rehomed_sessions moved
WHERE moved.client_id = client_interactions.session_id;

-- A session a client session parented is a root session, owned as before, as a person's WORK starts one now.
UPDATE sessions SET parent_session_id = NULL
WHERE parent_session_id IN (SELECT client_id FROM rehomed_sessions);

-- {§env-scheme} A person's environment is the runtime session's; overrides several persons kept have no one owner.
DELETE FROM session_module_state WHERE session_id IN (SELECT client_id FROM rehomed_sessions);

DELETE FROM sessions WHERE id IN (SELECT client_id FROM rehomed_sessions);

DROP TABLE rehomed_loops;
DROP TABLE rehomed_sessions;

-- No session carries the default flag any longer.
DROP INDEX sessions_workspace_default_session;
