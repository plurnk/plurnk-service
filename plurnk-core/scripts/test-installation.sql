-- Installation-only fixture writes. The consumer test opens these through
-- SqlRite against the baseline created by the installed `migrate` command.

-- PREP: installation_insert_workspace
INSERT INTO workspaces (name) VALUES ($name) RETURNING id;

-- PREP: installation_insert_worker
INSERT INTO workers (workspace_id, name, origin)
VALUES ($workspace_id, $name, 'model') RETURNING id;

-- PREP: installation_insert_loop
INSERT INTO loops (worker_id, sequence, prompt)
VALUES ($worker_id, 1, $prompt) RETURNING id;

-- PREP: installation_insert_turn
INSERT INTO turns (loop_id, sequence, status, packet)
VALUES ($loop_id, 1, 200, NULL);

-- PREP: installation_select_skills
SELECT entries.pathname, entry_channels.content
FROM entries
JOIN entry_channels ON entry_channels.entry_id = entries.id
WHERE entries.scheme = 'worker'
  AND entries.pathname LIKE '/skills/%'
  AND entry_channels.name = 'body';
