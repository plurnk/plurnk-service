-- MIGRATE: 17 skills module
-- Released in 2.0.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§skills-module} — rename ownership; definitions and enabledness remain exact.
UPDATE workspace_module_state
SET namespace_owner = '@plurnk/plurnk-skills'
WHERE namespace_owner = '@plurnk/plurnk-core/skills';
