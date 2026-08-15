-- Kernel pull-document reconciliation ({§schemes-self-doc-materialization}).

-- PREP: loop_docs_materialized
SELECT pathname
FROM entries
WHERE workspace_id = $workspace_id
  AND owner_id = $owner_id
  AND scheme = 'worker'
  AND substr(pathname, 1, 6) = '/docs/'
ORDER BY pathname;
