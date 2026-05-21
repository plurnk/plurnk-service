-- INIT: sessions_project_root
-- Adds the workspace pointer column to sessions per AGENTS.md §Phase F.1.
-- Nullable: NULL = headless (engine runs entries-only, no disk side-effects);
-- non-null = absolute path to the client's source tree, supplied at
-- session.create or session.set_root. Server never guesses.
ALTER TABLE sessions ADD COLUMN project_root TEXT;
