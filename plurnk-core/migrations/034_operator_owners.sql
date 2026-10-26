-- MIGRATE: 34 operator owners
-- Released in 4.3.3 and frozen ({§db-migrations}).
-- {§session-ownership} ACP operator owners are workspace-scoped (`acp://operator`), never per-principal or per-thread:
-- any existing `acp://*/threads/*` owner or interaction recipient is unified onto `acp://operator`.
INSERT INTO session_owners (workspace_id, address, tools, interactive)
SELECT w.workspace_id,
       'acp://operator',
       COALESCE(
           (SELECT json_group_array(tool)
            FROM (
                SELECT DISTINCT j.value AS tool
                FROM session_owners o, json_each(o.tools) j
                WHERE o.workspace_id = w.workspace_id
                  AND (o.address = 'acp://operator' OR o.address GLOB 'acp://*/threads/*')
            )),
           '[]'
       ),
       MAX(w.interactive)
FROM session_owners w
WHERE w.address GLOB 'acp://*/threads/*'
GROUP BY w.workspace_id
ON CONFLICT (workspace_id, address) DO UPDATE SET
    tools = excluded.tools,
    interactive = CASE WHEN session_owners.interactive = 1 OR excluded.interactive = 1 THEN 1 ELSE 0 END;

UPDATE sessions
SET owner = 'acp://operator'
WHERE owner GLOB 'acp://*/threads/*';

UPDATE client_interactions
SET recipient = 'acp://operator'
WHERE recipient GLOB 'acp://*/threads/*';

DELETE FROM session_owners
WHERE address GLOB 'acp://*/threads/*';
