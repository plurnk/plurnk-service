-- Workspace authored-skills reconciliation ({§skills-materialization}).
-- Mirrors loopDocs.sql's tracking pattern: kernel-owned worker://plurnk
-- entries whose pathnames carry the skills prefix, EXCLUDING the
-- kernel-generated /skills/plurnk/ namespace.

-- PREP: skill_docs_materialized
SELECT pathname
FROM entries
WHERE workspace_id = $workspace_id
  AND owner_id = $owner_id
  AND scheme = 'worker'
  AND authority = ''
  AND substr(pathname, 1, 8) = '/skills/'
  AND substr(pathname, 1, 15) <> '/skills/plurnk/'
ORDER BY pathname;
