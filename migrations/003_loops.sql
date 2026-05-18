-- INIT: loops
CREATE TABLE IF NOT EXISTS loops (
    id       INTEGER NOT NULL PRIMARY KEY,
    version  INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    run_id   INTEGER NOT NULL,
    sequence INTEGER NOT NULL             CHECK (sequence >= 1),
    status   INTEGER NOT NULL DEFAULT 102 CHECK (status IN (102, 200, 499)),
    prompt   TEXT    NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS loops_run_id_sequence ON loops (run_id, sequence);
