-- {§place-hiding} A hidden workspace or worker leaves the directories and the overview; every row stays. A worker's
-- hide marks it and every worker beneath it with the worker that hid it (`hidden_by`): one group, which returns whole.

-- INIT: loops_unhide_place
-- Nothing runs out of sight: a live loop starting on a worker brings back the group its worker belongs to, and the
-- workspace it runs in. A fork's copied history is never live, so it brings nothing back.
DROP TRIGGER IF EXISTS loops_unhide_place;
CREATE TRIGGER loops_unhide_place
AFTER INSERT ON loops
WHEN NEW.status IN (100, 102, 202)
BEGIN
    UPDATE workers SET hidden_at = NULL, hidden_by = NULL
    WHERE hidden_by = (SELECT hidden_by FROM workers WHERE id = NEW.worker_id);
    UPDATE workspaces SET hidden_at = NULL
    WHERE hidden_at IS NOT NULL AND id = (SELECT workspace_id FROM workers WHERE id = NEW.worker_id);
END;

-- INIT: workers_join_hidden_group
-- A worker created beneath a hidden worker joins its group.
DROP TRIGGER IF EXISTS workers_join_hidden_group;
CREATE TRIGGER workers_join_hidden_group
AFTER INSERT ON workers
WHEN EXISTS (SELECT 1 FROM workers WHERE id = NEW.parent_worker_id AND hidden_at IS NOT NULL)
BEGIN
    UPDATE workers
    SET hidden_at = (SELECT hidden_at FROM workers WHERE id = NEW.parent_worker_id),
        hidden_by = (SELECT hidden_by FROM workers WHERE id = NEW.parent_worker_id)
    WHERE id = NEW.id;
END;

-- PREP: place_scope
-- The workers a hide covers, a worker and every worker beneath it or every worker of a workspace, each with its live
-- loops ({§worker-lifecycle-live}) and open streams.
WITH RECURSIVE scope(id) AS (
    SELECT id FROM workers WHERE workspace_id = $workspace_id AND ($worker_id IS NULL OR id = $worker_id)
    UNION
    SELECT w.id FROM workers w JOIN scope ON w.parent_worker_id = scope.id
)
SELECT scope.id AS workerId,
       (SELECT COUNT(*) FROM loops l WHERE l.worker_id = scope.id AND l.status IN (100, 102, 202)) AS loops,
       (SELECT COUNT(*) FROM subscriptions s WHERE s.worker_id = scope.id AND s.closed_at IS NULL) AS streams
FROM scope;

-- PREP: place_workspace_mark
SELECT hidden_at FROM workspaces WHERE id = $workspace_id;

-- PREP: place_workspace_hide
-- Refused while any of its workers holds a live loop or an open stream; a second hide keeps the first mark.
UPDATE workspaces SET hidden_at = COALESCE(hidden_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE id = $workspace_id
  AND NOT EXISTS (SELECT 1 FROM loops l JOIN workers w ON w.id = l.worker_id
                  WHERE w.workspace_id = $workspace_id AND l.status IN (100, 102, 202))
  AND NOT EXISTS (SELECT 1 FROM subscriptions s JOIN workers w ON w.id = s.worker_id
                  WHERE w.workspace_id = $workspace_id AND s.closed_at IS NULL)
RETURNING hidden_at;

-- PREP: place_workspace_show
UPDATE workspaces SET hidden_at = NULL
WHERE id = $workspace_id AND hidden_at IS NOT NULL
RETURNING id;

-- PREP: place_worker_mark
SELECT hidden_at FROM workers WHERE id = $worker_id AND workspace_id = $workspace_id;

-- PREP: place_worker_hide
-- Refused while any worker of the subtree holds a live loop or an open stream. Groups already hidden inside the
-- subtree join this one.
WITH RECURSIVE subtree(id) AS (
    SELECT id FROM workers WHERE id = $worker_id AND workspace_id = $workspace_id
    UNION
    SELECT w.id FROM workers w JOIN subtree ON w.parent_worker_id = subtree.id
)
UPDATE workers SET hidden_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), hidden_by = $worker_id
WHERE id IN (SELECT id FROM subtree)
  AND NOT EXISTS (SELECT 1 FROM loops WHERE worker_id IN (SELECT id FROM subtree) AND status IN (100, 102, 202))
  AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE worker_id IN (SELECT id FROM subtree) AND closed_at IS NULL)
RETURNING id, hidden_at;

-- PREP: place_worker_show
-- Showing any worker of a group shows the group.
UPDATE workers SET hidden_at = NULL, hidden_by = NULL
WHERE hidden_by = (SELECT hidden_by FROM workers WHERE id = $worker_id AND workspace_id = $workspace_id)
RETURNING id;
