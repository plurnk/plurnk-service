-- {§machine-processes} An archived workspace or session leaves the directories and the overview; every row stays. A session's
-- archive marks it and every session beneath it with the session that archived it (`archived_by`): one group, which returns whole.

-- INIT: loops_unarchive_place
-- Nothing runs out of sight: a live loop starting on a session brings back the group its session belongs to, and the
-- workspace it runs in. A fork's copied history is never live, so it brings nothing back.
DROP TRIGGER IF EXISTS loops_unarchive_place;
CREATE TRIGGER loops_unarchive_place
AFTER INSERT ON loops
WHEN NEW.status IN (100, 102, 202)
BEGIN
    UPDATE sessions SET archived_at = NULL, archived_by = NULL
    WHERE archived_by = (SELECT archived_by FROM sessions WHERE id = NEW.session_id);
    UPDATE workspaces SET archived_at = NULL
    WHERE archived_at IS NOT NULL AND id = (SELECT workspace_id FROM sessions WHERE id = NEW.session_id);
END;

-- INIT: sessions_join_archived_group
-- A session created beneath an archived session joins its group.
DROP TRIGGER IF EXISTS sessions_join_archived_group;
CREATE TRIGGER sessions_join_archived_group
AFTER INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM sessions WHERE id = NEW.parent_session_id AND archived_at IS NOT NULL)
BEGIN
    UPDATE sessions
    SET archived_at = (SELECT archived_at FROM sessions WHERE id = NEW.parent_session_id),
        archived_by = (SELECT archived_by FROM sessions WHERE id = NEW.parent_session_id)
    WHERE id = NEW.id;
END;

-- INIT: ambient_events_retire_log_refs
DROP TRIGGER IF EXISTS ambient_events_retire_log_refs;
CREATE TRIGGER ambient_events_retire_log_refs
AFTER DELETE ON ambient_events
BEGIN
    UPDATE log_entry_rows SET ambient_event_id = NULL WHERE ambient_event_id = OLD.id;
END;

-- INIT: log_entries_retire_message_completions
DROP TRIGGER IF EXISTS log_entries_retire_message_completions;
CREATE TRIGGER log_entries_retire_message_completions
AFTER DELETE ON log_entry_rows
BEGIN
    DELETE FROM message_completions WHERE response_id = OLD.id;
END;

-- INIT: loops_retire_orphan_refs
DROP TRIGGER IF EXISTS loops_retire_orphan_refs;
CREATE TRIGGER loops_retire_orphan_refs
AFTER DELETE ON loops
BEGIN
    UPDATE loops SET orphan_source_loop_id = NULL WHERE orphan_source_loop_id = OLD.id;
END;

-- INIT: sessions_retire_archive_refs
DROP TRIGGER IF EXISTS sessions_retire_archive_refs;
CREATE TRIGGER sessions_retire_archive_refs
BEFORE DELETE ON sessions
BEGIN
    UPDATE sessions SET archived_at = NULL, archived_by = NULL WHERE id = OLD.id OR archived_by = OLD.id;
END;

-- PREP: place_scope
-- The sessions an archive or delete covers, a session and every session beneath it or every session of a workspace, each with its live
-- loops ({§session-loop-lifecycle}) and open streams.
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
SELECT archived_at FROM workspaces WHERE id = $workspace_id;

-- PREP: place_workspace_archive
-- Refused while any of its sessions holds a live loop or an open stream; a second archive keeps the first mark.
UPDATE workspaces SET archived_at = COALESCE(archived_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE id = $workspace_id
  AND NOT EXISTS (SELECT 1 FROM loops l JOIN sessions w ON w.id = l.session_id
                  WHERE w.workspace_id = $workspace_id AND l.status IN (100, 102, 202))
  AND NOT EXISTS (SELECT 1 FROM subscriptions s JOIN sessions w ON w.id = s.session_id
                  WHERE w.workspace_id = $workspace_id AND s.closed_at IS NULL)
RETURNING archived_at;

-- PREP: place_workspace_unarchive
UPDATE workspaces SET archived_at = NULL
WHERE id = $workspace_id AND archived_at IS NOT NULL
RETURNING id;

-- PREP: place_session_mark
SELECT archived_at, origin, title FROM sessions WHERE id = $session_id AND workspace_id = $workspace_id;

-- PREP: place_session_archive
-- Refused while any session of the subtree holds a live loop or an open stream. Groups already archived inside the
-- subtree join this one.
WITH RECURSIVE subtree(id) AS (
    SELECT id FROM sessions WHERE id = $session_id AND workspace_id = $workspace_id
    UNION
    SELECT w.id FROM sessions w JOIN subtree ON w.parent_session_id = subtree.id
)
UPDATE sessions SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), archived_by = $session_id
WHERE id IN (SELECT id FROM subtree)
  AND NOT EXISTS (SELECT 1 FROM loops WHERE session_id IN (SELECT id FROM subtree) AND status IN (100, 102, 202))
  AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE session_id IN (SELECT id FROM subtree) AND closed_at IS NULL)
RETURNING id, archived_at;

-- PREP: place_session_unarchive
-- Unarchiving any session of a group unarchives the group.
UPDATE sessions SET archived_at = NULL, archived_by = NULL
WHERE archived_by = (SELECT archived_by FROM sessions WHERE id = $session_id AND workspace_id = $workspace_id)
RETURNING id;

-- PREP: place_session_subtree
WITH RECURSIVE subtree(id) AS (
    SELECT id FROM sessions WHERE id = $session_id AND workspace_id = $workspace_id
    UNION
    SELECT w.id FROM sessions w JOIN subtree ON w.parent_session_id = subtree.id
)
SELECT id FROM subtree ORDER BY id;

-- PREP: place_session_delete
DELETE FROM sessions
WHERE id = $session_id AND workspace_id = $workspace_id
  AND origin = 'model'
  AND NOT EXISTS (
      WITH RECURSIVE subtree(id) AS (
          SELECT id FROM sessions WHERE id = $session_id AND workspace_id = $workspace_id
          UNION
          SELECT w.id FROM sessions w JOIN subtree ON w.parent_session_id = subtree.id
      )
      SELECT 1 FROM loops WHERE session_id IN (SELECT id FROM subtree) AND status IN (100, 102, 202)
  )
  AND NOT EXISTS (
      WITH RECURSIVE subtree(id) AS (
          SELECT id FROM sessions WHERE id = $session_id AND workspace_id = $workspace_id
          UNION
          SELECT w.id FROM sessions w JOIN subtree ON w.parent_session_id = subtree.id
      )
      SELECT 1 FROM subscriptions WHERE session_id IN (SELECT id FROM subtree) AND closed_at IS NULL
  )
RETURNING id;

-- PREP: place_session_title
UPDATE sessions SET title = $title
WHERE id = $session_id AND workspace_id = $workspace_id
RETURNING id, title;
