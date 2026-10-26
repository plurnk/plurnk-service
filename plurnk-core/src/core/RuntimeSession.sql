-- PREP: runtime_session_get
-- {§actor-boundary-self-hosting} The workspace's runtime actor is its one session of origin
-- `_plurnk`, found by that origin.
SELECT id FROM sessions WHERE workspace_id = $workspace_id AND origin = '_plurnk';

-- PREP: runtime_session_ensure
INSERT INTO sessions (workspace_id, name, origin)
VALUES ($workspace_id, '_plurnk', '_plurnk')
ON CONFLICT (workspace_id, name) DO UPDATE SET name = excluded.name
RETURNING id;
