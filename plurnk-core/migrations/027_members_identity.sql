-- MIGRATE: 27 members identity
-- {§members-functionality} {§functionality-addressing}: a members definition is its glob. Workspace
-- definitions are re-keyed by their glob. A service-origin row held only an enabledness override
-- keyed by the operator's environment alias, which no longer names a definition, so it is dropped;
-- a state left with no definition is removed, as the coordinator persists none.
UPDATE workspace_module_state
SET state = (
    SELECT json_object(
        'version', 1,
        'definitions', COALESCE(json_group_object(json_extract(value, '$.definition.glob'), json(value)), json('{}'))
    )
    FROM json_each(workspace_module_state.state, '$.definitions')
    WHERE json_extract(value, '$.origin') = 'workspace'
)
WHERE namespace_owner = '@plurnk/plurnk-core/members';

DELETE FROM workspace_module_state
WHERE namespace_owner = '@plurnk/plurnk-core/members'
  AND (SELECT COUNT(*) FROM json_each(workspace_module_state.state, '$.definitions')) = 0;
