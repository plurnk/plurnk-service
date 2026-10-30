-- MIGRATE: 11 definition shapes
-- Re-founded in 5.0.0 ({§db-migrations}).
-- {§db-migrations} Refuse databases from before the 5.0.0 support floor, naming both versions read.
CREATE TEMP TABLE IF NOT EXISTS _support_floor_probe (id INTEGER);
CREATE TEMP TRIGGER _support_floor_guard BEFORE INSERT ON _support_floor_probe
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_references')
BEGIN
    SELECT RAISE(ABORT, 'database schema (version ' || (SELECT user_version FROM pragma_user_version) || ') precedes the 5.0.0 support floor (schema version 11); point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})');
END;
INSERT INTO _support_floor_probe (id) VALUES (1);
DROP TABLE _support_floor_probe;

-- {§functionality-coordinator} {§mcp-server-definition} {§skills-sources} Stored MCP and Skill definitions key by alias in the enclosing map and carry no redundant inner `name`.
UPDATE workspace_module_state
SET state = json_set(
    state,
    '$.definitions',
    COALESCE(
        (SELECT json_group_object(
            d.key,
            CASE
                WHEN json_type(d.value, '$.definition') = 'object'
                THEN json_set(d.value, '$.definition', json_remove(json_extract(d.value, '$.definition'), '$.name'))
                ELSE json(d.value)
            END
        )
        FROM json_each(workspace_module_state.state, '$.definitions') AS d),
        json('{}')
    )
)
WHERE namespace_owner IN ('@plurnk/plurnk-mcp', '@plurnk/plurnk-skills')
  AND json_type(state, '$.definitions') = 'object';
