-- Session generated-document reconciliation on plurnk:/// and mcp:///
-- ({§tools-resource-materialization}, {§functionality-model-projection}).

-- PREP: loop_docs_materialized
-- An outer join cannot flatten the entry_channels view, so this one reads its tables ({§content-store}).
SELECT e.scheme, e.pathname, COALESCE(ec.buffer, b.content) AS content
FROM entries e
LEFT JOIN entry_channel_rows ec ON ec.entry_id = e.id AND ec.name = 'body'
LEFT JOIN contents b ON b.id = ec.content_id
WHERE e.workspace_id = $workspace_id
  AND e.scheme IN ('plurnk', 'mcp')
  AND e.authority = ''
ORDER BY e.scheme, e.pathname;
