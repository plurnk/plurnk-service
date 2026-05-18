-- INIT: visibility
CREATE TABLE IF NOT EXISTS visibility (
    run_id   INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    channel  TEXT    NOT NULL           CHECK (length(channel) > 0),
    indexed  INTEGER NOT NULL DEFAULT 1 CHECK (indexed IN (0, 1)),
    PRIMARY KEY (run_id, entry_id, channel),
    FOREIGN KEY (run_id)   REFERENCES runs(id)    ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
