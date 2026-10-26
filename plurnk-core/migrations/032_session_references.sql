-- MIGRATE: 32 session references
-- Released in 4.0.0 and frozen ({§db-migrations}).
-- {§session-external-reference} Protocol adapters own the opaque key; core owns its durable target.
CREATE TABLE session_references (
    namespace TEXT NOT NULL CHECK (length(namespace) > 0),
    reference TEXT NOT NULL,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    PRIMARY KEY (namespace, reference)
) STRICT, WITHOUT ROWID;

CREATE INDEX session_references_session ON session_references (session_id);

CREATE TRIGGER session_reference_identity
BEFORE UPDATE ON session_references
BEGIN
    SELECT RAISE(ABORT, 'session reference is immutable');
END;

CREATE TRIGGER session_reference_model
BEFORE INSERT ON session_references
WHEN EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id AND origin != 'model')
BEGIN
    SELECT RAISE(ABORT, 'session reference requires a model session');
END;

CREATE VIEW session_reference_allocations AS
SELECT r.namespace, r.reference, s.name AS workspace_name, w.name AS session_name
FROM session_references r JOIN sessions w ON w.id = r.session_id
JOIN workspaces s ON s.id = w.workspace_id;
