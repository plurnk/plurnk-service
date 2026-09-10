-- Worker generated-document reconciliation: the whole {§worker-generated-subtree}
-- — scheme and tool references, AGENTS.md, and every Functionality family's
-- documents ({§schemes-self-doc-materialization}, {§tools-resource-materialization},
-- {§functionality-documents}).

-- PREP: loop_docs_materialized
SELECT e.pathname, ec.content
FROM entries e
LEFT JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
WHERE e.workspace_id = $workspace_id
  AND e.scheme = 'worker'
  AND e.authority = ''
  AND substr(e.pathname, 1, 9) = '/_plurnk/'
ORDER BY e.pathname;
