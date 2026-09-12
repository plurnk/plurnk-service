-- workspace-settings: the workspace's durable settings bag.

-- PREP: workspace_get_settings
-- {§operator-config} — the workspace's validated client settings bag, read at
-- each owning use site with its declared composition semantics.
SELECT settings FROM workspaces WHERE id = $workspace_id;
