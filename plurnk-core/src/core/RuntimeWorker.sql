-- PREP: runtime_worker_get
-- {§actor-boundary-self-hosting} The workspace's runtime actor is its one worker of origin
-- `_plurnk`. The name is not the key: a database created before the actor took the name
-- `_plurnk` carries `plurnk`, and stays found by origin until it is recreated.
SELECT id FROM workers WHERE workspace_id = $workspace_id AND origin = '_plurnk';

-- PREP: runtime_worker_ensure
INSERT INTO workers (workspace_id, name, origin)
VALUES ($workspace_id, '_plurnk', '_plurnk')
ON CONFLICT (workspace_id, name) DO UPDATE SET name = excluded.name
RETURNING id;
