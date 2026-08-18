-- Workspace skills reconciliation ({§skills-materialization}).
-- Mirrors loopDocs.sql's tracking pattern: kernel-owned worker://plurnk
-- entries whose pathnames carry the skills prefix.

-- PREP: skill_docs_materialized
SELECT pathname
FROM entries
WHERE workspace_id = $workspace_id
  AND owner_id = $owner_id
  AND scheme = 'worker'
  AND substr(pathname, 1, 8) = '/skills/'
ORDER BY pathname;
