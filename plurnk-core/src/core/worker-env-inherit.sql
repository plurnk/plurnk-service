-- The environment a child starts from (SPEC {§exec-env-scoped}, operator ruling 2026-09-13 on
-- #586). A child inherits a COPY of its parent's registry, taken at spawn: the child owns it,
-- so its later edits never reach the parent and the parent's never reach a running child.
--
-- FORK already gets this from workers_fork_copies_history, which snapshots every quiescent
-- worker-authority entry ({§machine-processes-entry-inheritance}) — a fork is a continuation, so
-- it carries what was done as well as how.
--
-- WORK is the new case, and it copies the registry ALONE. A fresh log is about what was said,
-- not about the machine: a child inherits how work is done, not what was done. That keeps the
-- WORK/FORK difference exactly where it already is — the log — instead of spreading it.

-- INIT: workers_work_inherits_env
DROP TRIGGER IF EXISTS workers_work_inherits_env;
CREATE TRIGGER workers_work_inherits_env
AFTER INSERT ON workers
WHEN NEW.fork_event_boundary IS NULL
 AND NEW.parent_worker_id IS NOT NULL
BEGIN
    -- The entry, under the child's own name: {§worker-authority-carving} makes authority a
    -- literal namespace, so the registry is addressed by the worker's name.
    INSERT INTO entries (workspace_id, scheme, authority, pathname, attributes)
    SELECT NEW.workspace_id, e.scheme, NEW.name, e.pathname, e.attributes
    FROM entries e
    WHERE e.workspace_id = NEW.workspace_id
      AND e.authority = (SELECT name FROM workers WHERE id = NEW.parent_worker_id)
      AND e.scheme = 'worker'
      AND e.pathname = '/.env'
      AND NOT EXISTS (SELECT 1 FROM entry_channels c WHERE c.entry_id = e.id AND c.state = 'active');

    -- The document itself, copied faithfully: a disabled entry is a commented line, and the
    -- parent's masking is part of the shape it hands over.
    INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, deep_hash, state, producer_result)
    SELECT ne.id, c.name, c.content, c.mimetype, c.weight, c.content_hash, c.deep_hash, c.state, c.producer_result
    FROM entry_channels c
    JOIN entries oe ON oe.id = c.entry_id
    JOIN entries ne ON ne.workspace_id = oe.workspace_id AND ne.scheme = oe.scheme
                   AND ne.pathname = oe.pathname AND ne.authority = NEW.name
    WHERE oe.workspace_id = NEW.workspace_id
      AND oe.authority = (SELECT name FROM workers WHERE id = NEW.parent_worker_id)
      AND oe.scheme = 'worker'
      AND oe.pathname = '/.env';
END;
