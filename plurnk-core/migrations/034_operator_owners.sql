-- MIGRATE: 34 operator owners
-- Released in 4.3.3 and frozen ({§db-migrations}).
-- {§worker-ownership} AG-UI owners are workspace-scoped (`agui://operator`), never per-principal or per-thread:
-- any existing `agui://*/threads/*` owner or interaction recipient is unified onto `agui://operator`.
INSERT INTO worker_owners (workspace_id, address, tools, interactive)
SELECT w.workspace_id,
       'agui://operator',
       COALESCE(
           (SELECT json_group_array(tool)
            FROM (
                SELECT DISTINCT j.value AS tool
                FROM worker_owners o, json_each(o.tools) j
                WHERE o.workspace_id = w.workspace_id
                  AND (o.address = 'agui://operator' OR o.address GLOB 'agui://*/threads/*')
            )),
           '[]'
       ),
       MAX(w.interactive)
FROM worker_owners w
WHERE w.address GLOB 'agui://*/threads/*'
GROUP BY w.workspace_id
ON CONFLICT (workspace_id, address) DO UPDATE SET
    tools = excluded.tools,
    interactive = CASE WHEN worker_owners.interactive = 1 OR excluded.interactive = 1 THEN 1 ELSE 0 END;

UPDATE workers
SET owner = 'agui://operator'
WHERE owner GLOB 'agui://*/threads/*';

UPDATE client_interactions
SET recipient = 'agui://operator'
WHERE recipient GLOB 'agui://*/threads/*';

DELETE FROM worker_owners
WHERE address GLOB 'agui://*/threads/*';
