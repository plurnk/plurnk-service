-- INIT: runs
CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER NOT NULL PRIMARY KEY,
    version       INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    session_id    INTEGER NOT NULL,
    name          TEXT    NOT NULL CHECK (length(name) > 0),
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    parent_run_id INTEGER          CHECK (parent_run_id IS NULL OR parent_run_id != id),
    cost_pico     INTEGER NOT NULL DEFAULT 0 CHECK (cost_pico >= 0),
    FOREIGN KEY (session_id)    REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_run_id) REFERENCES runs(id)     ON DELETE CASCADE
) STRICT;

CREATE        INDEX IF NOT EXISTS runs_session_id_created_at ON runs (session_id, created_at);
CREATE        INDEX IF NOT EXISTS runs_parent_run_id         ON runs (parent_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS runs_session_name          ON runs (session_id, name);
