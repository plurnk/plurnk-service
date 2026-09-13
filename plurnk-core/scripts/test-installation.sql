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
INSERT INTO turns (loop_id, sequence, producer, kind, status)
VALUES ($loop_id, 1, 'client', 'operation', 200)
RETURNING id;

-- PREP: installation_insert_turn_ops
-- {§turn-source-resources}: the program a turn emitted is source evidence on the
-- turn, which is where the digest reads its assistant projection.
INSERT INTO turn_sources (turn_id, kind, content)
VALUES ($turn_id, 'ops', $content);

-- PREP: installation_select_capability_docs
SELECT entries.workspace_id, entries.pathname, entry_channels.content
FROM entries
JOIN entry_channels ON entry_channels.entry_id = entries.id
WHERE entries.scheme = 'worker'
  AND (
    entries.pathname LIKE '/_plurnk/skills/%'
    OR entries.pathname LIKE '/_plurnk/plurnk/%'
  )
  AND entry_channels.name = 'body';
