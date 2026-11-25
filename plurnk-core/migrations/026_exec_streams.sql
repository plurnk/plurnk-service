-- MIGRATE: 26 exec streams and project root index
-- Released in 9.0.0 and frozen ({§db-migrations}).
-- {§db-migrations} {§execution-output-identity} Advance 8.0.0 databases in place to 9.0.0:
-- re-home execution output entries, subscriptions, log observations, and stream provenance
-- onto `exec:///<runtime>/<id>`, index `workspaces(project_root)`, and refresh turn-ownership guards.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'persona')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 8.0.0 support floor (schema version 25); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

CREATE INDEX workspaces_project_root ON workspaces (project_root);

DROP TRIGGER IF EXISTS log_entry_rows_immutable_core;
DROP TRIGGER IF EXISTS log_entry_rows_immutable_attrs;

UPDATE log_entry_rows
SET pathname = '/' || scheme || pathname,
    scheme = 'exec'
WHERE scheme IS NOT NULL
  AND scheme != 'exec'
  AND pathname IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM sessions s
      JOIN entries e ON e.workspace_id = s.workspace_id
      WHERE s.id = log_entry_rows.session_id
        AND e.output = 1
        AND e.scheme = log_entry_rows.scheme
        AND e.authority = COALESCE(log_entry_rows.hostname, '')
        AND e.pathname = log_entry_rows.pathname
  );

UPDATE log_entry_rows
SET attrs = json_set(
    attrs,
    '$.pathname', '/' || (CASE WHEN json_extract(attrs, '$.runtime') = '' THEN 'sh' ELSE json_extract(attrs, '$.runtime') END) || json_extract(attrs, '$.pathname'),
    '$.stream', 'exec:///' || (CASE WHEN json_extract(attrs, '$.runtime') = '' THEN 'sh' ELSE json_extract(attrs, '$.runtime') END) || json_extract(attrs, '$.pathname')
)
WHERE json_type(attrs, '$.stream') = 'text'
  AND json_type(attrs, '$.runtime') = 'text'
  AND json_type(attrs, '$.pathname') = 'text'
  AND json_extract(attrs, '$.stream') NOT LIKE 'exec://%';

CREATE TRIGGER log_entry_rows_immutable_core
BEFORE UPDATE OF
    session_id, loop_id, turn_id, sequence, at, origin, source, inherited_history, model_call_id,
    op, signal, scheme, username, password, hostname,
    port, pathname, query, fragment, lineMarker, tx_content_id, mimetype_tx, mimetype_rx, initial_folded
ON log_entry_rows
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only lifecycle outcome and derived attachments may change');
END;

CREATE TRIGGER log_entry_rows_immutable_attrs
BEFORE UPDATE OF attrs ON log_entry_rows
WHEN COALESCE((
    json_type(OLD.attrs, '$.__plurnk_curation') = 'object'
    AND NEW.attrs = json_remove(OLD.attrs, '$.__plurnk_curation')
), 0) = 0
BEGIN
    SELECT RAISE(ABORT, 'log_entries attrs are immutable outside curation payload removal');
END;

UPDATE ambient_events
SET pathname = '/' || scheme || pathname,
    scheme = 'exec'
WHERE scheme IS NOT NULL
  AND scheme != 'exec'
  AND pathname IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM entries e
      WHERE e.workspace_id = ambient_events.workspace_id
        AND e.output = 1
        AND e.scheme = ambient_events.scheme
        AND e.authority = COALESCE(ambient_events.hostname, '')
        AND e.pathname = ambient_events.pathname
  );

UPDATE ambient_events
SET attrs = json_set(
    attrs,
    '$.pathname', '/' || (CASE WHEN json_extract(attrs, '$.runtime') = '' THEN 'sh' ELSE json_extract(attrs, '$.runtime') END) || json_extract(attrs, '$.pathname'),
    '$.stream', 'exec:///' || (CASE WHEN json_extract(attrs, '$.runtime') = '' THEN 'sh' ELSE json_extract(attrs, '$.runtime') END) || json_extract(attrs, '$.pathname')
)
WHERE json_type(attrs, '$.stream') = 'text'
  AND json_type(attrs, '$.runtime') = 'text'
  AND json_type(attrs, '$.pathname') = 'text'
  AND json_extract(attrs, '$.stream') NOT LIKE 'exec://%';

DROP TRIGGER IF EXISTS subscriptions_identity_update;

UPDATE subscriptions
SET scheme = 'exec'
WHERE scheme != 'exec'
  AND EXISTS (
      SELECT 1 FROM entries e
      WHERE e.id = subscriptions.entry_id
        AND e.output = 1
  );

CREATE TRIGGER subscriptions_identity_update
BEFORE UPDATE OF session_id, entry_id, scheme, source ON subscriptions
WHEN NEW.entry_id != OLD.entry_id OR NEW.scheme != OLD.scheme OR NEW.source IS NOT OLD.source
  OR (NEW.session_id IS NOT OLD.session_id AND NOT (NEW.session_id IS NULL AND NEW.closed_at IS NOT NULL))
BEGIN
    SELECT RAISE(ABORT, 'subscription identity is immutable');
END;

UPDATE entries
SET pathname = '/' || scheme || pathname,
    scheme = 'exec'
WHERE output = 1
  AND scheme != 'exec';

DROP TRIGGER IF EXISTS log_entry_rows_turn_ownership;
CREATE TRIGGER log_entry_rows_turn_ownership
BEFORE INSERT ON log_entry_rows
WHEN NEW.session_id IS NOT NULL
 AND NEW.loop_id IS NOT NULL
 AND NEW.turn_id IS NOT NULL
 AND NEW.origin IN ('model', 'client', '_plurnk')
 AND EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id)
 AND EXISTS (SELECT 1 FROM loops WHERE id = NEW.loop_id)
 AND EXISTS (SELECT 1 FROM turns WHERE id = NEW.turn_id)
 AND NOT EXISTS (
     SELECT 1 FROM turns
     JOIN loops ON loops.id = turns.loop_id
     WHERE turns.id = NEW.turn_id
       AND loops.id = NEW.loop_id
       AND loops.session_id = NEW.session_id
       AND (NEW.origin = turns.producer OR NEW.origin = '_plurnk')
 )
BEGIN
    SELECT RAISE(ABORT, 'log entry must match its turn ownership and producer');
END;
