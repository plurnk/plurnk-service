-- Worker generated-document reconciliation: the whole {§worker-generated-subtree}
-- — scheme and tool references, AGENTS.md, and every Functionality family's
-- documents ({§schemes-self-doc-materialization}, {§tools-resource-materialization},
-- {§functionality-documents}).

-- PREP: loop_docs_materialized
-- An outer join cannot flatten the entry_channels view, so this one reads its tables ({§content-store}).
SELECT e.pathname, COALESCE(ec.buffer, b.content) AS content
FROM entries e
LEFT JOIN entry_channel_rows ec ON ec.entry_id = e.id AND ec.name = 'body'
LEFT JOIN contents b ON b.id = ec.content_id
WHERE e.workspace_id = $workspace_id
  AND e.scheme = 'worker'
  AND e.authority = ''
  AND substr(e.pathname, 1, 9) = '/_plurnk/'
ORDER BY e.pathname;
