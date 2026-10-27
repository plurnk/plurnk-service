-- {§machine-processes} A hidden workspace or session leaves the directories and the overview; every row stays. A session's
-- hide marks it and every session beneath it with the session that hid it (`hidden_by`): one group, which returns whole.

-- INIT: loops_unhide_place
-- Nothing runs out of sight: a live loop starting on a session brings back the group its session belongs to, and the
-- workspace it runs in. A fork's copied history is never live, so it brings nothing back.
DROP TRIGGER IF EXISTS loops_unhide_place;
CREATE TRIGGER loops_unhide_place
AFTER INSERT ON loops
WHEN NEW.status IN (100, 102, 202)
BEGIN
    UPDATE sessions SET hidden_at = NULL, hidden_by = NULL
    WHERE hidden_by = (SELECT hidden_by FROM sessions WHERE id = NEW.session_id);
    UPDATE workspaces SET hidden_at = NULL
    WHERE hidden_at IS NOT NULL AND id = (SELECT workspace_id FROM sessions WHERE id = NEW.session_id);
END;

-- INIT: sessions_join_hidden_group
-- A session created beneath a hidden session joins its group.
DROP TRIGGER IF EXISTS sessions_join_hidden_group;
CREATE TRIGGER sessions_join_hidden_group
AFTER INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM sessions WHERE id = NEW.parent_session_id AND hidden_at IS NOT NULL)
BEGIN
    UPDATE sessions
    SET hidden_at = (SELECT hidden_at FROM sessions WHERE id = NEW.parent_session_id),
        hidden_by = (SELECT hidden_by FROM sessions WHERE id = NEW.parent_session_id)
    WHERE id = NEW.id;
END;

-- PREP: place_scope
-- The sessions a hide covers, a session and every session beneath it or every session of a workspace, each with its live
-- loops ({§session-lifecycle-live}) and open streams.
WITH RECURSIVE scope(id) AS (
    SELECT id FROM sessions WHERE workspace_id = $workspace_id AND ($session_id IS NULL OR id = $session_id)
    UNION
    SELECT w.id FROM sessions w JOIN scope ON w.parent_session_id = scope.id
)
SELECT scope.id AS sessionId,
       (SELECT COUNT(*) FROM loops l WHERE l.session_id = scope.id AND l.status IN (100, 102, 202)) AS loops,
       (SELECT COUNT(*) FROM subscriptions s WHERE s.session_id = scope.id AND s.closed_at IS NULL) AS streams
FROM scope;

-- PREP: place_workspace_mark
SELECT hidden_at FROM workspaces WHERE id = $workspace_id;

-- PREP: place_workspace_hide
-- Refused while any of its sessions holds a live loop or an open stream; a second hide keeps the first mark.
UPDATE workspaces SET hidden_at = COALESCE(hidden_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE id = $workspace_id
  AND NOT EXISTS (SELECT 1 FROM loops l JOIN sessions w ON w.id = l.session_id
                  WHERE w.workspace_id = $workspace_id AND l.status IN (100, 102, 202))
  AND NOT EXISTS (SELECT 1 FROM subscriptions s JOIN sessions w ON w.id = s.session_id
                  WHERE w.workspace_id = $workspace_id AND s.closed_at IS NULL)
RETURNING hidden_at;

-- PREP: place_workspace_show
UPDATE workspaces SET hidden_at = NULL
WHERE id = $workspace_id AND hidden_at IS NOT NULL
RETURNING id;

-- PREP: place_session_mark
SELECT hidden_at FROM sessions WHERE id = $session_id AND workspace_id = $workspace_id;

-- PREP: place_session_hide
-- Refused while any session of the subtree holds a live loop or an open stream. Groups already hidden inside the
-- subtree join this one.
WITH RECURSIVE subtree(id) AS (
    SELECT id FROM sessions WHERE id = $session_id AND workspace_id = $workspace_id
    UNION
    SELECT w.id FROM sessions w JOIN subtree ON w.parent_session_id = subtree.id
)
UPDATE sessions SET hidden_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), hidden_by = $session_id
WHERE id IN (SELECT id FROM subtree)
  AND NOT EXISTS (SELECT 1 FROM loops WHERE session_id IN (SELECT id FROM subtree) AND status IN (100, 102, 202))
  AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE session_id IN (SELECT id FROM subtree) AND closed_at IS NULL)
RETURNING id, hidden_at;

-- PREP: place_session_show
-- Showing any session of a group shows the group.
UPDATE sessions SET hidden_at = NULL, hidden_by = NULL
WHERE hidden_by = (SELECT hidden_by FROM sessions WHERE id = $session_id AND workspace_id = $workspace_id)
RETURNING id;
