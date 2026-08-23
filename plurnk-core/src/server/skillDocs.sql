-- Worker-authored skills reconciliation ({§skills-materialization}).
-- Owns the standard Agent Skills slice of {§worker-generated-subtree}:
-- /_plurnk/skills/* except the Plurnk-generated /_plurnk/skills/plurnk/ references.

-- PREP: skill_docs_materialized
SELECT e.pathname, ec.content
FROM entries e
JOIN workers owner ON owner.id = e.owner_id
LEFT JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
WHERE owner.workspace_id = $workspace_id
  AND e.owner_id = $owner_id
  AND e.scheme = 'worker'
  AND e.authority = ''
  AND substr(e.pathname, 1, 16) = '/_plurnk/skills/'
  AND substr(e.pathname, 1, 23) <> '/_plurnk/skills/plurnk/'
ORDER BY e.pathname;
