-- MIGRATE: 35 acp operator owners
-- {§worker-ownership} Operator-owned workers and pending interactions use `acp://operator`:
-- any existing `agui://operator` owner or interaction recipient is unified onto `acp://operator`.
INSERT INTO worker_owners (workspace_id, address, tools, interactive)
SELECT w.workspace_id,
       'acp://operator',
       COALESCE(
           (SELECT json_group_array(tool)
            FROM (
                SELECT DISTINCT j.value AS tool
                FROM worker_owners o, json_each(o.tools) j
                WHERE o.workspace_id = w.workspace_id
                  AND o.address IN ('acp://operator', 'agui://operator')
            )),
           '[]'
       ),
       MAX(w.interactive)
FROM worker_owners w
WHERE w.address = 'agui://operator'
GROUP BY w.workspace_id
ON CONFLICT (workspace_id, address) DO UPDATE SET
    tools = excluded.tools,
    interactive = CASE WHEN worker_owners.interactive = 1 OR excluded.interactive = 1 THEN 1 ELSE 0 END;

UPDATE workers
SET owner = 'acp://operator'
WHERE owner = 'agui://operator';

UPDATE client_interactions
SET recipient = 'acp://operator'
WHERE recipient = 'agui://operator';

DELETE FROM worker_owners
WHERE address = 'agui://operator';
