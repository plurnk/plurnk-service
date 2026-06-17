-- run:// op family — the run-table primitive spawn/irc need beyond fork.sql.
-- Resolve a sister run by name, WITHIN a session only (the actor boundary — a
-- model never reaches another session's runs, SPEC §machine-processes). Newest
-- wins if a name was reused. spawn reuses fork.sql's run-insert (fork_insert_run,
-- the identical INSERT); fork reuses Fork.fork; only by-name resolution is new.

-- PREP: run_resolve_by_name
SELECT id FROM runs WHERE session_id = $session_id AND name = $name
ORDER BY id DESC LIMIT 1;

-- PREP: run_count_active
-- Runs in a session with a non-terminal loop (status 100 pending / 102 in-progress)
-- — "active" for the PLURNK_SESSION_RUNS_MAX_ACTIVE ceiling (run-cap.ts).
SELECT COUNT(DISTINCT r.id) AS n FROM runs r
JOIN loops l ON l.run_id = r.id
WHERE r.session_id = $session_id AND l.status IN (100, 102);
