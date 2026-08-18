-- Kernel reference-resource reconciliation ({§schemes-self-doc-materialization},
-- {§tools-resource-materialization}) — the generated Plurnk skills under
-- worker://plurnk/skills/plurnk/ plus the project-AGENTS entry.

-- PREP: loop_docs_materialized
SELECT pathname
FROM entries
WHERE workspace_id = $workspace_id
  AND owner_id = $owner_id
  AND scheme = 'worker'
  AND (pathname = '/agents.md' OR substr(pathname, 1, 15) = '/skills/plurnk/')
ORDER BY pathname;
