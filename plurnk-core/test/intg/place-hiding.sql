-- {§machine-processes} witnesses: the marks a workspace and its sessions carry.

-- PREP: test_place_marks
SELECT 'workspace' AS place, id, hidden_at, NULL AS hidden_by FROM workspaces WHERE id = $workspace_id
UNION ALL
SELECT 'session' AS place, id, hidden_at, hidden_by FROM sessions WHERE workspace_id = $workspace_id
ORDER BY place, id;
