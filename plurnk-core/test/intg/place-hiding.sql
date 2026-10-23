-- {§place-hiding} witnesses: the marks a workspace and its workers carry.

-- PREP: test_place_marks
SELECT 'workspace' AS place, id, hidden_at, NULL AS hidden_by FROM workspaces WHERE id = $workspace_id
UNION ALL
SELECT 'worker' AS place, id, hidden_at, hidden_by FROM workers WHERE workspace_id = $workspace_id
ORDER BY place, id;
