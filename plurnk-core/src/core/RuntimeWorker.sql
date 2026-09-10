-- PREP: runtime_worker_ensure
INSERT INTO workers (workspace_id, name, origin)
VALUES ($workspace_id, 'plurnk', '_plurnk')
ON CONFLICT (workspace_id, name) DO UPDATE SET name = excluded.name
RETURNING id;
