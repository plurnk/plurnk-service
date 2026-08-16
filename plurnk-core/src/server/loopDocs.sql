-- Kernel reference-resource reconciliation ({§schemes-self-doc-materialization},
-- {§tools-resource-materialization}).

-- PREP: loop_docs_materialized
SELECT pathname
FROM entries
WHERE workspace_id = $workspace_id
  AND owner_id = $owner_id
  AND scheme = 'worker'
  AND (substr(pathname, 1, 6) = '/docs/' OR substr(pathname, 1, 7) = '/tools/')
ORDER BY pathname;
