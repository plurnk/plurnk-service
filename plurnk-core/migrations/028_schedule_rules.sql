-- MIGRATE: 28 schedule manual and once rules
-- Released in 9.0.0 and frozen ({§db-migrations}).
-- {§db-migrations} {§schedule-rule}
-- Migrate persisted unscheduled `rule: null` schedule definitions to explicit `rule: "once"` in place.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'workspaces_project_root')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 8.0.0 support floor (schema version 25); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

UPDATE workspace_module_state
SET state = json_set(
    state,
    '$.definitions',
    json((
        SELECT json_group_object(
            je.key,
            CASE
                WHEN json_type(je.value, '$.definition.rule') = 'null'
                THEN json(json_set(je.value, '$.definition.rule', 'once'))
                ELSE json(je.value)
            END
        )
        FROM json_each(workspace_module_state.state, '$.definitions') AS je
    ))
)
WHERE namespace_owner = '@plurnk/plurnk-schedule'
  AND json_type(state, '$.definitions') = 'object'
  AND EXISTS (
      SELECT 1
      FROM json_each(workspace_module_state.state, '$.definitions') AS je
      WHERE json_type(je.value, '$.definition.rule') = 'null'
  );
