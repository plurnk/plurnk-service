-- Worker reference-resource reconciliation ({§schemes-self-doc-materialization},
-- {§tools-resource-materialization}) — generated Plurnk skills and the
-- project-AGENTS entry in one private Worker address space.

-- PREP: loop_docs_materialized
SELECT e.pathname, ec.content
FROM entries e
JOIN workers owner ON owner.id = e.owner_id
LEFT JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
WHERE owner.workspace_id = $workspace_id
  AND e.owner_id = $owner_id
  AND e.scheme = 'worker'
  AND e.authority = ''
  AND (e.pathname = '/agents.md' OR substr(e.pathname, 1, 15) = '/skills/plurnk/')
ORDER BY e.pathname;
