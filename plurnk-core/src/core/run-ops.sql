-- worker:// op family — the run-table primitive spawn/irc need beyond fork.sql.
-- Resolve a sister worker by name, WITHIN a workspace only (the actor boundary — a
-- model never reaches another workspace's workers, SPEC §machine-processes). Newest
-- wins if a name was reused. spawn reuses fork.sql's run-insert (fork_insert_worker,
-- the identical INSERT); fork reuses Fork.fork; only by-name resolution is new.

-- PREP: worker_resolve_by_name
SELECT id FROM workers WHERE workspace_id = $workspace_id AND name = $name
ORDER BY id DESC LIMIT 1;

-- PREP: worker_name_by_id
-- A worker's name from its id (§worker-scheme) — the worker:/// self-fold resolves the
-- acting run (ctx.workerId) to its name to key its worker-scope entries by authority.
SELECT name FROM workers WHERE id = $worker_id;

-- PREP: worker_deliverable_by_name
-- The newest run holding this name, with its latest loop's status + terminal message — the
-- deliverable a sister COLLECTS by READing worker://<name> (§worker-scheme-collect, the pull side of
-- the same deliverable the push delta carries). Terminal status → the message is the result (200)
-- or the abandonment reason; non-terminal → the worker hasn't delivered yet (READ steers to 202).
-- terminated_by names an external cancellation so COLLECT renders its marker.
SELECT r.id AS worker_id, l.status, l.terminal_message, l.terminated_by
FROM workers r
JOIN loops l ON l.worker_id = r.id
WHERE r.workspace_id = $workspace_id AND r.name = $name
ORDER BY r.id DESC, l.sequence DESC
LIMIT 1;

-- PREP: worker_live_by_name
-- The newest run holding this name that is still LIVE (a non-terminal loop, 100/102) —
-- the spawn gate's collision check. A hit means the name is in use by a running sister
-- (refuse: 409); no hit means the name is free or held only by a terminated run (reclaim).
SELECT r.id FROM workers r
JOIN loops l ON l.worker_id = r.id
WHERE r.workspace_id = $workspace_id AND r.name = $name AND l.status IN (100, 102)
ORDER BY r.id DESC LIMIT 1;

-- PREP: worker_count_active
-- Runs in a workspace with a non-terminal loop (status 100 pending / 102 in-progress)
-- — "active" for the PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE ceiling (run-cap.ts).
SELECT COUNT(DISTINCT r.id) AS n FROM workers r
JOIN loops l ON l.worker_id = r.id
WHERE r.workspace_id = $workspace_id AND l.status IN (100, 102);
