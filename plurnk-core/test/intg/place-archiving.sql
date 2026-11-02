-- {§machine-processes} witnesses: the marks a workspace and its sessions carry.

-- PREP: test_place_marks
SELECT 'workspace' AS place, id, archived_at, NULL AS archived_by FROM workspaces WHERE id = $workspace_id
UNION ALL
SELECT 'session' AS place, id, archived_at, archived_by FROM sessions WHERE workspace_id = $workspace_id
ORDER BY place, id;
