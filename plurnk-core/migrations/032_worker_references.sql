-- MIGRATE: 32 worker references
-- {§worker-external-reference} Protocol adapters own the opaque key; core owns its durable target.
CREATE TABLE worker_references (
    namespace TEXT NOT NULL CHECK (length(namespace) > 0),
    reference TEXT NOT NULL,
    worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    PRIMARY KEY (namespace, reference)
) STRICT, WITHOUT ROWID;

CREATE INDEX worker_references_worker ON worker_references (worker_id);

CREATE TRIGGER worker_reference_identity
BEFORE UPDATE ON worker_references
BEGIN
    SELECT RAISE(ABORT, 'worker reference is immutable');
END;

CREATE TRIGGER worker_reference_model
BEFORE INSERT ON worker_references
WHEN EXISTS (SELECT 1 FROM workers WHERE id = NEW.worker_id AND origin != 'model')
BEGIN
    SELECT RAISE(ABORT, 'worker reference requires a model worker');
END;

CREATE VIEW worker_reference_allocations AS
SELECT r.namespace, r.reference, s.name AS workspace_name, w.name AS worker_name
FROM worker_references r JOIN workers w ON w.id = r.worker_id
JOIN workspaces s ON s.id = w.workspace_id;
