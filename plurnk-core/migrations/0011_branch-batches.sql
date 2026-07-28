-- MIGRATE: 11 branch_batches
-- A branch batch is a durable exclusive transaction over the privileged
-- project repository. Legacy repository-forest constraints are removed.

CREATE TABLE workspace_constraints_v11 (
    workspace_id INTEGER NOT NULL,
    effect       TEXT    NOT NULL CHECK (effect IN ('pick', 'hide', 'view')),
    glob         TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, effect, glob),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO workspace_constraints_v11 (workspace_id, effect, glob)
SELECT workspace_id, effect, glob
FROM workspace_constraints
WHERE effect IN ('pick', 'hide', 'view');

DROP TABLE workspace_constraints;
ALTER TABLE workspace_constraints_v11 RENAME TO workspace_constraints;

CREATE TABLE branch_batches (
    id                INTEGER NOT NULL PRIMARY KEY,
    workspace_id      INTEGER NOT NULL,
    parent_worker_id  INTEGER NOT NULL,
    parent_loop_id    INTEGER NOT NULL,
    parent_turn_id    INTEGER NOT NULL UNIQUE,
    state             TEXT    NOT NULL DEFAULT 'collecting'
                      CHECK (state IN ('collecting', 'queued', 'running', 'completed', 'failed', 'recovery_required')),
    active_sequence   INTEGER CHECK (active_sequence IS NULL OR active_sequence >= 1),
    repository_path   TEXT CHECK (repository_path IS NULL OR length(repository_path) > 0),
    original_ref      TEXT,
    original_commit   TEXT CHECK (original_commit IS NULL OR length(original_commit) > 0),
    problem           TEXT CHECK (problem IS NULL OR json_valid(problem)),
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at      TEXT,
    CHECK (
        (repository_path IS NULL AND original_commit IS NULL)
        OR (repository_path IS NOT NULL AND original_commit IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_loop_id) REFERENCES loops(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX branch_batches_one_active_per_workspace
ON branch_batches (workspace_id)
WHERE state IN ('collecting', 'queued', 'running', 'recovery_required');

CREATE TABLE branch_batch_items (
    id            INTEGER NOT NULL PRIMARY KEY,
    batch_id      INTEGER NOT NULL,
    sequence      INTEGER NOT NULL CHECK (sequence >= 1),
    worker_id     INTEGER NOT NULL,
    loop_id       INTEGER NOT NULL,
    branch        TEXT    NOT NULL CHECK (length(branch) > 0),
    state         TEXT    NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'recovery_required')),
    result        TEXT CHECK (result IS NULL OR json_valid(result)),
    result_commit TEXT CHECK (result_commit IS NULL OR length(result_commit) > 0),
    changed       INTEGER CHECK (changed IS NULL OR changed IN (0, 1)),
    started_at    TEXT,
    completed_at  TEXT,
    UNIQUE (batch_id, sequence),
    UNIQUE (batch_id, branch),
    FOREIGN KEY (batch_id) REFERENCES branch_batches(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
) STRICT;
