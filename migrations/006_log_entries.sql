CREATE TABLE log_entries (
    id              INTEGER NOT NULL PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),

    run_id          INTEGER NOT NULL,
    loop_id         INTEGER NOT NULL,
    turn_id         INTEGER NOT NULL,
    action_index    INTEGER NOT NULL           CHECK (action_index >= 0),
    at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    origin          TEXT    NOT NULL           CHECK (origin IN ('model', 'client', 'system', 'plugin')),

    op              TEXT    NOT NULL           CHECK (op IN ('FIND', 'READ', 'EDIT', 'COPY', 'MOVE', 'SHOW', 'HIDE', 'SEND', 'EXEC')),
    suffix          TEXT    NOT NULL DEFAULT '',
    signal          TEXT                       CHECK (signal IS NULL OR json_valid(signal)),

    target_scheme   TEXT                       CHECK (target_scheme IS NULL OR length(target_scheme) > 0),
    target_username TEXT,
    target_password TEXT,
    target_hostname TEXT,
    target_port     INTEGER                    CHECK (target_port IS NULL OR (target_port BETWEEN 0 AND 65535)),
    target_pathname TEXT,
    target_params   TEXT                       CHECK (target_params IS NULL OR json_valid(target_params)),
    target_fragment TEXT,

    lineMarker      TEXT                       CHECK (lineMarker IS NULL OR json_valid(lineMarker)),

    tx              TEXT    NOT NULL,
    mimetype_tx     TEXT    NOT NULL           CHECK (length(mimetype_tx) > 0),

    rx              TEXT    NOT NULL,
    mimetype_rx     TEXT    NOT NULL           CHECK (length(mimetype_rx) > 0),
    status_rx       INTEGER NOT NULL           CHECK (status_rx BETWEEN 100 AND 599),

    tokens          INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),

    FOREIGN KEY (run_id)  REFERENCES runs(id)  ON DELETE CASCADE,
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX log_entries_turn_id_action_index ON log_entries (turn_id, action_index);
CREATE INDEX        log_entries_run_id               ON log_entries (run_id);
CREATE INDEX        log_entries_loop_id              ON log_entries (loop_id);
CREATE INDEX        log_entries_at                   ON log_entries (at);

CREATE TRIGGER log_entries_immutable
BEFORE UPDATE ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries are append-only; INSERT new rows instead of UPDATE');
END;
