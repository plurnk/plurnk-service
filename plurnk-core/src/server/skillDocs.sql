-- Worker-authored skills reconciliation ({§skills-materialization}).
-- Mirrors loopDocs.sql's tracking pattern while excluding the generated
-- /skills/plurnk/ namespace.

-- PREP: skill_docs_materialized
SELECT e.pathname, ec.content
FROM entries e
JOIN workers owner ON owner.id = e.owner_id
LEFT JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
WHERE owner.workspace_id = $workspace_id
  AND e.owner_id = $owner_id
  AND e.scheme = 'worker'
  AND e.authority = ''
  AND substr(e.pathname, 1, 8) = '/skills/'
  AND substr(e.pathname, 1, 15) <> '/skills/plurnk/'
ORDER BY e.pathname;
