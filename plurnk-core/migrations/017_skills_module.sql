-- MIGRATE: 17 skills module
-- {§skills-module} — rename ownership; definitions and enabledness remain exact.
UPDATE workspace_module_state
SET namespace_owner = '@plurnk/plurnk-skills'
WHERE namespace_owner = '@plurnk/plurnk-core/skills';
